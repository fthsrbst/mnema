import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { Text, Heading } from "@astryxdesign/core/Text";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Divider } from "@astryxdesign/core/Divider";
import { Badge } from "@astryxdesign/core/Badge";
import { Item } from "@astryxdesign/core/Item";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { api, type GrowthStats, type HealthStatus, type RagStats, type SessionLog, type UsageStats } from "../api";
import { useI18n, type Lang, type TKey } from "../i18n";
import { Markdown } from "../components/Markdown";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// --- Bilgi büyümesi grafiği (saf SVG — kütüphane yok) ---

const SERIES = [
  { key: "memories", labelKey: "dashboard.seriesMemories", color: "var(--color-icon-blue)" },
  { key: "sessions", labelKey: "dashboard.seriesSessions", color: "var(--color-icon-green)" },
  { key: "documents", labelKey: "dashboard.seriesDocuments", color: "var(--color-icon-orange)" },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];
type CumulativePoint = { day: string } & Record<SeriesKey, number>;

/** Günlük sayıları eksik günleri doldurarak kümülatif seriye çevirir. */
function buildCumulative(daily: GrowthStats["daily"]): CumulativePoint[] {
  if (daily.length === 0) return [];
  const byDay = new Map(daily.map((r) => [r.day, r]));
  const endDay = new Date().toISOString().slice(0, 10);
  const startDay = daily[0].day <= endDay ? daily[0].day : endDay;
  const out: CumulativePoint[] = [];
  let memories = 0;
  let sessions = 0;
  let documents = 0;
  let cursor = new Date(startDay + "T00:00:00Z").getTime();
  for (let i = 0; i < 400; i++) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    const row = byDay.get(day);
    if (row) {
      memories += row.memories;
      sessions += row.sessions;
      documents += row.documents;
    }
    out.push({ day, memories, sessions, documents });
    if (day >= endDay) break;
    cursor += 86400000;
  }
  return out;
}

function formatDay(day: string, lang: Lang): string {
  const d = new Date(day + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(lang === "tr" ? "tr-TR" : "en-US", { day: "numeric", month: "short", timeZone: "UTC" });
}

function GrowthChart({ growth }: { growth: GrowthStats }) {
  const { t, lang } = useI18n();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const points = buildCumulative(growth.daily);

  if (points.length === 0) {
    return <EmptyState title={t("dashboard.growthEmpty")} description={t("dashboard.growthEmptyDesc")} />;
  }

  const W = 640;
  const H = 220;
  const padL = 36;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = points.length;
  const last = points[n - 1];
  const yMax = Math.max(last.memories, last.sessions, last.documents, 1);
  const x = (i: number) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + (1 - v / yMax) * plotH;
  const yBase = padT + plotH;

  const linePoints = (key: SeriesKey) =>
    n === 1
      ? `${padL},${y(points[0][key]).toFixed(1)} ${padL + plotW},${y(points[0][key]).toFixed(1)}`
      : points.map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");

  const areaPath = (key: SeriesKey) => {
    const pts =
      n === 1
        ? [`${padL},${y(points[0][key]).toFixed(1)}`, `${padL + plotW},${y(points[0][key]).toFixed(1)}`]
        : points.map((p, i) => `${x(i).toFixed(1)},${y(p[key]).toFixed(1)}`);
    return `M ${pts[0]} L ${pts.slice(1).join(" L ")} L ${(padL + plotW).toFixed(1)},${yBase} L ${padL},${yBase} Z`;
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    if (n === 1) {
      setHoverIdx(0);
      return;
    }
    const idx = Math.round(((relX - padL) / plotW) * (n - 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  };

  const hover = hoverIdx === null ? null : points[hoverIdx];
  const hoverX = hoverIdx === null ? 0 : x(hoverIdx);
  const tooltipW = 148;
  const tooltipX = hoverX + tooltipW + 12 > W - padR ? hoverX - tooltipW - 12 : hoverX + 12;

  const gridLevels = [0.5, 1];
  const xTicks = n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <VStack gap={3}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t("dashboard.growthTitle")}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* yatay ızgara + y ekseni etiketleri */}
        <line x1={padL} y1={yBase} x2={padL + plotW} y2={yBase} stroke="var(--color-border-emphasized)" strokeWidth={1} />
        {gridLevels.map((g) => (
          <g key={g}>
            <line x1={padL} y1={y(yMax * g)} x2={padL + plotW} y2={y(yMax * g)} stroke="var(--color-border)" strokeWidth={1} />
            <text x={padL - 6} y={y(yMax * g) + 3} textAnchor="end" fontSize={10} fill="var(--color-text-secondary)">
              {Math.round(yMax * g)}
            </text>
          </g>
        ))}
        <text x={padL - 6} y={yBase + 3} textAnchor="end" fontSize={10} fill="var(--color-text-secondary)">0</text>

        {/* x ekseni etiketleri */}
        {xTicks.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 6}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            fontSize={10}
            fill="var(--color-text-secondary)"
          >
            {formatDay(points[i].day, lang)}
          </text>
        ))}

        {/* alan dolguları + çizgiler */}
        {SERIES.map((s) => (
          <path key={`area-${s.key}`} d={areaPath(s.key)} fill={s.color} opacity={0.12} />
        ))}
        {SERIES.map((s) => (
          <polyline
            key={`line-${s.key}`}
            points={linePoints(s.key)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* hover: dikey çizgi + noktalar + tooltip */}
        {hover && (
          <g pointerEvents="none">
            <line x1={hoverX} y1={padT} x2={hoverX} y2={yBase} stroke="var(--color-border-emphasized)" strokeWidth={1} />
            {SERIES.map((s) => (
              <circle key={`dot-${s.key}`} cx={n === 1 ? hoverX : hoverX} cy={y(hover[s.key])} r={3.5} fill={s.color} />
            ))}
            <rect
              x={tooltipX}
              y={padT}
              width={tooltipW}
              height={20 + SERIES.length * 16}
              rx={6}
              fill="var(--color-background-popover)"
              stroke="var(--color-border-emphasized)"
              strokeWidth={1}
            />
            <text x={tooltipX + 10} y={padT + 16} fontSize={11} fill="var(--color-text-primary)">
              {formatDay(hover.day, lang)}
            </text>
            {SERIES.map((s, si) => (
              <g key={`tt-${s.key}`}>
                <circle cx={tooltipX + 14} cy={padT + 28 + si * 16} r={3.5} fill={s.color} />
                <text x={tooltipX + 24} y={padT + 32 + si * 16} fontSize={11} fill="var(--color-text-secondary)">
                  {t(s.labelKey as TKey)}: {hover[s.key]}
                </text>
              </g>
            ))}
          </g>
        )}
      </svg>

      {/* lejant + toplamlar */}
      <HStack gap={5} vAlign="center" wrap="wrap">
        {SERIES.map((s) => (
          <HStack key={`legend-${s.key}`} gap={1.5} vAlign="center">
            <svg width={10} height={10} viewBox="0 0 10 10" aria-hidden="true">
              <circle cx={5} cy={5} r={5} fill={s.color} />
            </svg>
            <Text type="supporting" color="secondary">
              {t(s.labelKey as TKey)}: {growth.totals[s.key]}
            </Text>
          </HStack>
        ))}
        <Text type="supporting" color="secondary">
          {growth.totals.chunks} {t("dashboard.chunksLabel")}
        </Text>
      </HStack>
    </VStack>
  );
}

// --- kullanım paneli: en çok başvurulan + uzun süredir erişilmeyen kayıtlar ---

function UsageSection({ usage, formatRelative }: { usage: UsageStats; formatRelative: (iso: string | null) => string }) {
  const { t } = useI18n();
  return (
    <Card>
      <VStack gap={4}>
        <Heading level={4}>{t("dashboard.usageTitle")}</Heading>

        <VStack gap={2}>
          <Text type="label" color="secondary">{t("dashboard.usageTopTitle")}</Text>
          {usage.top.length === 0 ? (
            <Text type="supporting" color="secondary">{t("dashboard.usageTopEmpty")}</Text>
          ) : (
            <VStack gap={0}>
              {usage.top.slice(0, 10).map((it) => (
                <Item
                  key={`top-${it.type}-${it.id}`}
                  density="compact"
                  label={it.title}
                  labelLines={1}
                  description={`${it.type}${it.project ? ` · ${it.project}` : ""} · ${t("dashboard.usageLastAccessed")}: ${formatRelative(it.last_accessed)}`}
                  endContent={<Badge variant="info" label={`${it.access_count} ${t("dashboard.usageAccessCount")}`} />}
                />
              ))}
            </VStack>
          )}
        </VStack>

        <Divider />

        <VStack gap={2}>
          <Collapsible
            defaultIsOpen={false}
            trigger={
              <HStack gap={2} vAlign="center">
                <Text type="label" color="secondary">{t("dashboard.usageStaleTitle")}</Text>
                {usage.stale_count > 0 && <Badge variant="warning" label={String(usage.stale_count)} />}
              </HStack>
            }
          >
            <VStack gap={0} paddingBlock={2}>
              {usage.stale.length === 0 ? (
                <Text type="supporting" color="secondary">{t("dashboard.usageStaleEmpty")}</Text>
              ) : (
                usage.stale.map((it) => (
                  <Item
                    key={`stale-${it.type}-${it.id}`}
                    density="compact"
                    label={it.title}
                    labelLines={1}
                    description={it.project ? `${it.type} · ${it.project}` : it.type}
                    endContent={<Text type="supporting" color="secondary">{formatRelative(it.last_accessed)}</Text>}
                  />
                ))
              )}
            </VStack>
          </Collapsible>
          {usage.stale_count > 0 && (
            <Text type="supporting" color="secondary">
              {usage.stale_count} {t("dashboard.usageStaleRecords")}
            </Text>
          )}
        </VStack>
      </VStack>
    </Card>
  );
}

export function Dashboard() {
  const { t } = useI18n();
  const [stats, setStats] = useState<RagStats | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [sessions, setSessions] = useState<SessionLog[] | null>(null);
  const [growth, setGrowth] = useState<GrowthStats | null>(null);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  function formatRelative(iso: string | null): string {
    if (!iso) return t("dashboard.never");
    const then = new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z")).getTime();
    if (Number.isNaN(then)) return iso;
    const diffMs = Date.now() - then;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return t("dashboard.justNow");
    if (mins < 60) return `${mins} ${t("dashboard.minutesAgo")}`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} ${t("dashboard.hoursAgo")}`;
    const days = Math.floor(hours / 24);
    return `${days} ${t("dashboard.daysAgo")}`;
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [s, h, sess, g] = await Promise.all([
        api<RagStats>("GET", "/api/rag/stats"),
        fetch("/health").then((r) => r.json() as Promise<HealthStatus>),
        api<SessionLog[]>("GET", "/api/sessions?limit=5"),
        api<GrowthStats>("GET", "/api/stats/growth?days=90"),
      ]);
      setStats(s);
      setHealth(h);
      setSessions(sess);
      setGrowth(g);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
    try {
      // Ayrı try/catch: eski sunucularda uç 404 dönebilir — bölüm o durumda sessizce gizlenir.
      setUsage(await api<UsageStats>("GET", "/api/stats/usage"));
    } catch {
      setUsage(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <VStack gap={5}>
      <HStack hAlign="between" vAlign="center">
        <VStack gap={1}>
          <Heading level={3}>{t("dashboard.title")}</Heading>
          <Text type="supporting" color="secondary">{t("dashboard.subtitle")}</Text>
        </VStack>
        <Button label={t("common.refresh")} variant="secondary" onClick={load} isDisabled={loading} />
      </HStack>

      {error && (
        <Card variant="red">
          <Text color="secondary">{t("dashboard.loadFailed")}: {error}</Text>
        </Card>
      )}

      {loading && !stats ? (
        <Text color="secondary">{t("common.loading")}</Text>
      ) : stats ? (
        <>
          <Grid columns={{ minWidth: 260, repeat: "fit" }} gap={4}>
            <Card>
              <VStack gap={2}>
                <HStack hAlign="between" vAlign="center">
                  <Text type="supporting" color="secondary">{t("dashboard.server")}</Text>
                  <StatusDot
                    variant={health?.ok ? "success" : "error"}
                    label={health?.ok ? t("dashboard.running") : t("dashboard.unreachable")}
                    isPulsing={!!health?.ok}
                  />
                </HStack>
                <Heading level={4}>{health?.ok ? t("dashboard.online") : t("dashboard.offline")}</Heading>
                <Text type="supporting" color="secondary">v{health?.version ?? "?"}</Text>
              </VStack>
            </Card>

            <Card>
              <VStack gap={2}>
                <Text type="supporting" color="secondary">{t("dashboard.database")}</Text>
                <Heading level={4}>{formatBytes(stats.db_size_bytes)}</Heading>
                <Text type="supporting" color="secondary" style={{ wordBreak: "break-all" }}>{stats.db_path}</Text>
              </VStack>
            </Card>

            <Card>
              <VStack gap={2}>
                <HStack hAlign="between" vAlign="center">
                  <Text type="supporting" color="secondary">{t("dashboard.vectorSearch")}</Text>
                  <StatusDot
                    variant={stats.vec_available ? "success" : "warning"}
                    label={stats.vec_available ? t("dashboard.vecActive") : t("dashboard.vecFtsOnly")}
                  />
                </HStack>
                <Heading level={4}>{stats.vec_available ? t("dashboard.vecActiveDesc") : t("dashboard.vecInactiveDesc")}</Heading>
                <Text type="supporting" color="secondary">
                  {stats.embeddings_enabled ? `${stats.embedding_model} (${stats.embedding_dim}d)` : t("dashboard.embeddingOff")}
                </Text>
              </VStack>
            </Card>

            <Card>
              <VStack gap={2}>
                <Text type="supporting" color="secondary">{t("dashboard.sync")}</Text>
                <Heading level={4}>{stats.sync.primary_url ? t("dashboard.peerMode") : t("dashboard.standaloneMode")}</Heading>
                <Text type="supporting" color="secondary">
                  {stats.sync.primary_url || t("dashboard.noPrimaryUrl")}
                </Text>
              </VStack>
            </Card>
          </Grid>

          <Grid columns={{ minWidth: 320, repeat: "fit" }} gap={4}>
            <Card>
              <VStack gap={3}>
                <Heading level={4}>{t("dashboard.documents")}</Heading>
                <HStack hAlign="between">
                  <Text type="supporting" color="secondary">{t("dashboard.total")}</Text>
                  <Text>{stats.documents.total}</Text>
                </HStack>
                <HStack hAlign="between">
                  <Text type="supporting" color="secondary">{t("dashboard.active")}</Text>
                  <Text>{stats.documents.enabled}</Text>
                </HStack>
                <HStack hAlign="between">
                  <Text type="supporting" color="secondary">{t("dashboard.disabled")}</Text>
                  <Text>{stats.documents.disabled}</Text>
                </HStack>
              </VStack>
            </Card>

            <Card>
              <VStack gap={3}>
                <Heading level={4}>{t("dashboard.chunkEmbedRatio")}</Heading>
                <ProgressBar
                  label={t("dashboard.chunkEmbedRatio")}
                  isLabelHidden
                  value={stats.chunks.embedded}
                  max={Math.max(stats.chunks.total, 1)}
                  hasValueLabel
                  variant={stats.chunks.total === 0 ? "neutral" : stats.chunks.embedded === stats.chunks.total ? "success" : "warning"}
                />
                <Text type="supporting" color="secondary">
                  {stats.chunks.embedded} / {stats.chunks.total} {t("dashboard.chunksHave")}
                </Text>
              </VStack>
            </Card>

            <Card>
              <VStack gap={3}>
                <Heading level={4}>{t("dashboard.memoryEmbedRatio")}</Heading>
                <ProgressBar
                  label={t("dashboard.memoryEmbedRatio")}
                  isLabelHidden
                  value={stats.memories.embedded}
                  max={Math.max(stats.memories.total, 1)}
                  hasValueLabel
                  variant={stats.memories.total === 0 ? "neutral" : stats.memories.embedded === stats.memories.total ? "success" : "warning"}
                />
                <Text type="supporting" color="secondary">
                  {stats.memories.embedded} / {stats.memories.total} {t("dashboard.recordsHave")}
                </Text>
              </VStack>
            </Card>
          </Grid>

          {growth && (
            <Card>
              <VStack gap={3}>
                <VStack gap={1}>
                  <Heading level={4}>{t("dashboard.growthTitle")}</Heading>
                  <Text type="supporting" color="secondary">{t("dashboard.growthSubtitle")}</Text>
                </VStack>
                <GrowthChart growth={growth} />
              </VStack>
            </Card>
          )}

          {usage && <UsageSection usage={usage} formatRelative={formatRelative} />}

          {stats.sync.peers.length > 0 && (
            <Card>
              <VStack gap={3}>
                <Heading level={4}>{t("dashboard.peerStatus")}</Heading>
                <Divider />
                {stats.sync.peers.map((p) => (
                  <HStack key={p.peer} hAlign="between" vAlign="center">
                    <Text type="supporting">{p.peer}</Text>
                    <HStack gap={4}>
                      <Text type="supporting" color="secondary">{t("dashboard.lastPull")}: {formatRelative(p.last_pull)}</Text>
                      <Text type="supporting" color="secondary">{t("dashboard.lastPush")}: {formatRelative(p.last_push)}</Text>
                    </HStack>
                  </HStack>
                ))}
              </VStack>
            </Card>
          )}

          <Card>
            <VStack gap={3}>
              <HStack hAlign="between" vAlign="center">
                <Heading level={4}>{t("dashboard.recentSessions")}</Heading>
              </HStack>
              <Divider />
              {sessions === null ? (
                <Text color="secondary">{t("common.loading")}</Text>
              ) : sessions.length === 0 ? (
                <EmptyState title={t("dashboard.noSessions")} description={t("dashboard.noSessionsDesc")} />
              ) : (
                sessions.map((log) => (
                  <VStack key={log.id} gap={1}>
                    <HStack gap={3} vAlign="center">
                      <Text type="supporting" color="secondary">{log.created_at}</Text>
                      {log.project && <Text type="supporting">[{log.project}]</Text>}
                    </HStack>
                    <Markdown headingLevelStart={5}>{log.summary}</Markdown>
                  </VStack>
                ))
              )}
            </VStack>
          </Card>
        </>
      ) : null}
    </VStack>
  );
}
