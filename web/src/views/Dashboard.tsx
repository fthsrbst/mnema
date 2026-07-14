import { useCallback, useEffect, useState } from "react";
import { VStack, HStack, Grid } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { Heading, Text } from "../components/ui/Typography";
import { StatusDot, LivePill, Tag } from "../components/ui/Tag";
import { PixelMeter } from "../components/ui/PixelMeter";
import { EmptyState } from "../components/ui/EmptyState";
import { Divider, SectionRule } from "../components/ui/Divider";
import { Collapsible } from "../components/ui/Collapsible";
import { ListRow } from "../components/ui/ListRow";
import { Ticker } from "../components/ui/Ticker";
import { Dither } from "../components/ui/Dither";
import { api, type GrowthStats, type HealthStatus, type RagStats, type SessionLog, type UsageStats } from "../api";
import { useI18n, type Lang, type TKey } from "../i18n";
import { Markdown } from "../components/Markdown";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// --- Bilgi büyümesi grafiği — saf SVG, monokrom step-line + kare noktalar ---

const SERIES = [
  { key: "memories", labelKey: "dashboard.seriesMemories" },
  { key: "sessions", labelKey: "dashboard.seriesSessions" },
  { key: "documents", labelKey: "dashboard.seriesDocuments" },
] as const;

type SeriesKey = (typeof SERIES)[number]["key"];
type CumulativePoint = { day: string } & Record<SeriesKey, number>;

const SERIES_DASH: Record<SeriesKey, string | undefined> = {
  memories: undefined,
  sessions: "4 3",
  documents: "1 3",
};

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
  const H = 200;
  const padL = 30;
  const padR = 8;
  const padT = 10;
  const padB = 20;
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
        <line x1={padL} y1={yBase} x2={padL + plotW} y2={yBase} stroke="var(--border-strong)" strokeWidth={1} />
        <text x={padL - 6} y={yBase + 3} textAnchor="end" fontSize={9} fontFamily="var(--font-mono)" fill="var(--fg-dim)">0</text>
        <text x={padL - 6} y={y(yMax) + 3} textAnchor="end" fontSize={9} fontFamily="var(--font-mono)" fill="var(--fg-dim)">{yMax}</text>

        {xTicks.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={H - 4}
            textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
            fontSize={9}
            fontFamily="var(--font-mono)"
            fill="var(--fg-dim)"
          >
            {formatDay(points[i].day, lang)}
          </text>
        ))}

        {SERIES.map((s) => (
          <polyline
            key={`line-${s.key}`}
            points={linePoints(s.key)}
            fill="none"
            stroke="var(--fg)"
            strokeWidth={1.5}
            strokeDasharray={SERIES_DASH[s.key]}
            strokeLinejoin="miter"
          />
        ))}

        {hover && (
          <g pointerEvents="none">
            <line x1={hoverX} y1={padT} x2={hoverX} y2={yBase} stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="2 2" />
            {SERIES.map((s) => (
              <rect key={`dot-${s.key}`} x={hoverX - 2.5} y={y(hover[s.key]) - 2.5} width={5} height={5} fill="var(--fg)" />
            ))}
          </g>
        )}
      </svg>

      <HStack gap={5} vAlign="center" wrap="wrap">
        {SERIES.map((s) => (
          <HStack key={`legend-${s.key}`} gap={1} vAlign="center">
            <svg width={14} height={2} aria-hidden="true">
              <line x1={0} y1={1} x2={14} y2={1} stroke="var(--fg)" strokeWidth={1.5} strokeDasharray={SERIES_DASH[s.key]} />
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

function UsageSection({ usage, formatRelative }: { usage: UsageStats; formatRelative: (iso: string | null) => string }) {
  const { t } = useI18n();
  return (
    <Panel>
      <VStack gap={4}>
        <Heading level={4}>{t("dashboard.usageTitle")}</Heading>

        <VStack gap={1}>
          <span className="u-label">{t("dashboard.usageTopTitle")}</span>
          {usage.top.length === 0 ? (
            <Text type="supporting" color="secondary">{t("dashboard.usageTopEmpty")}</Text>
          ) : (
            <VStack gap={0}>
              {usage.top.slice(0, 10).map((it, idx) => (
                <ListRow
                  key={`top-${it.type}-${it.id}`}
                  bordered={idx > 0}
                  title={it.title}
                  description={`${it.type}${it.project ? ` · ${it.project}` : ""} · ${t("dashboard.usageLastAccessed")}: ${formatRelative(it.last_accessed)}`}
                  end={<Tag>{it.access_count} {t("dashboard.usageAccessCount")}</Tag>}
                />
              ))}
            </VStack>
          )}
        </VStack>

        <Divider />

        <VStack gap={2}>
          <Collapsible
            trigger={
              <HStack gap={2} vAlign="center">
                <span className="u-label">{t("dashboard.usageStaleTitle")}</span>
                {usage.stale_count > 0 && <Tag variant="warn">{usage.stale_count}</Tag>}
              </HStack>
            }
          >
            <VStack gap={0}>
              {usage.stale.length === 0 ? (
                <Text type="supporting" color="secondary">{t("dashboard.usageStaleEmpty")}</Text>
              ) : (
                usage.stale.map((it, idx) => (
                  <ListRow
                    key={`stale-${it.type}-${it.id}`}
                    bordered={idx > 0}
                    title={it.title}
                    description={it.project ? `${it.type} · ${it.project}` : it.type}
                    end={
                      <HStack gap={2} vAlign="center">
                        {it.importance >= 1.5 && <Tag variant="warn">{t("dashboard.usageImportance")} {it.importance}</Tag>}
                        <Text type="supporting" color="secondary">{formatRelative(it.last_accessed)}</Text>
                      </HStack>
                    }
                  />
                ))
              )}
            </VStack>
          </Collapsible>
        </VStack>
      </VStack>
    </Panel>
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
      <Panel className="hero-panel" padded={false}>
        <Dither opacity={0.5} />
        <div className="hero-panel-content" style={{ padding: "var(--sp-6) var(--sp-5)" }}>
          <VStack gap={4}>
            <HStack hAlign="between" vAlign="center">
              <LivePill>{t("dashboard.heroBadge")}</LivePill>
              <Button label={t("common.refresh")} variant="secondary" onClick={load} disabled={loading} />
            </HStack>
            <div className="hero-title">
              {t("dashboard.heroTitleLine1")}
              <br />
              {t("dashboard.heroTitleLine2")}
            </div>
            <Text color="secondary">{t("dashboard.heroCaption")}</Text>
          </VStack>
        </div>
      </Panel>

      {error && (
        <Panel variant="danger">
          <Text color="secondary">{t("dashboard.loadFailed")}: {error}</Text>
        </Panel>
      )}

      {loading && !stats ? (
        <Text color="secondary">{t("common.loading")}</Text>
      ) : stats ? (
        <>
          <Grid minWidth={240} gap={4}>
            <Panel>
              <VStack gap={2}>
                <HStack hAlign="between" vAlign="center">
                  <span className="u-label">{t("dashboard.server")}</span>
                  <StatusDot variant={health?.ok ? "success" : "error"} label={health?.ok ? t("dashboard.running") : t("dashboard.unreachable")} pulsing={!!health?.ok} />
                </HStack>
                <span className="ticker ticker--sm">{health?.ok ? t("dashboard.online") : t("dashboard.offline")}</span>
                <Text type="supporting" color="secondary">v{health?.version ?? "?"}</Text>
              </VStack>
            </Panel>

            <Panel>
              <VStack gap={2}>
                <span className="u-label">{t("dashboard.database")}</span>
                <span className="ticker ticker--sm">{formatBytes(stats.db_size_bytes)}</span>
                <Text type="supporting" color="secondary" style={{ wordBreak: "break-all" }}>{stats.db_path}</Text>
              </VStack>
            </Panel>

            <Panel>
              <VStack gap={2}>
                <HStack hAlign="between" vAlign="center">
                  <span className="u-label">{t("dashboard.vectorSearch")}</span>
                  <StatusDot variant={stats.vec_available ? "success" : "warning"} label={stats.vec_available ? t("dashboard.vecActive") : t("dashboard.vecFtsOnly")} />
                </HStack>
                <span className="ticker ticker--sm">{stats.vec_available ? t("dashboard.vecActiveDesc") : t("dashboard.vecInactiveDesc")}</span>
                <Text type="supporting" color="secondary">
                  {stats.embeddings_enabled ? `${stats.embedding_model} (${stats.embedding_dim}d)` : t("dashboard.embeddingOff")}
                </Text>
              </VStack>
            </Panel>

            <Panel>
              <VStack gap={2}>
                <span className="u-label">{t("dashboard.sync")}</span>
                <span className="ticker ticker--sm">{stats.sync.primary_url ? t("dashboard.peerMode") : t("dashboard.standaloneMode")}</span>
                <Text type="supporting" color="secondary">{stats.sync.primary_url || t("dashboard.noPrimaryUrl")}</Text>
              </VStack>
            </Panel>
          </Grid>

          <Grid minWidth={300} gap={4}>
            <Panel>
              <VStack gap={3}>
                <span className="u-label">{t("dashboard.documents")}</span>
                <Ticker value={stats.documents.total} />
                <HStack hAlign="between">
                  <Text type="supporting" color="secondary">{t("dashboard.active")}</Text>
                  <Text type="supporting">{stats.documents.enabled}</Text>
                </HStack>
                <HStack hAlign="between">
                  <Text type="supporting" color="secondary">{t("dashboard.disabled")}</Text>
                  <Text type="supporting">{stats.documents.disabled}</Text>
                </HStack>
              </VStack>
            </Panel>

            <Panel>
              <VStack gap={3}>
                <span className="u-label">{t("dashboard.chunkEmbedRatio")}</span>
                <Ticker value={stats.chunks.total === 0 ? 0 : Math.round((stats.chunks.embedded / stats.chunks.total) * 100)} />
                <PixelMeter
                  value={stats.chunks.embedded}
                  max={Math.max(stats.chunks.total, 1)}
                  variant={stats.chunks.total === 0 ? "default" : stats.chunks.embedded === stats.chunks.total ? "success" : "warning"}
                />
                <Text type="supporting" color="secondary">{stats.chunks.embedded} / {stats.chunks.total} {t("dashboard.chunksHave")}</Text>
              </VStack>
            </Panel>

            <Panel>
              <VStack gap={3}>
                <span className="u-label">{t("dashboard.memoryEmbedRatio")}</span>
                <Ticker value={stats.memories.total === 0 ? 0 : Math.round((stats.memories.embedded / stats.memories.total) * 100)} />
                <PixelMeter
                  value={stats.memories.embedded}
                  max={Math.max(stats.memories.total, 1)}
                  variant={stats.memories.total === 0 ? "default" : stats.memories.embedded === stats.memories.total ? "success" : "warning"}
                />
                <Text type="supporting" color="secondary">{stats.memories.embedded} / {stats.memories.total} {t("dashboard.recordsHave")}</Text>
              </VStack>
            </Panel>
          </Grid>

          {growth && (
            <Panel>
              <VStack gap={3}>
                <SectionRule label={t("dashboard.growthTitle")} />
                <Text type="supporting" color="secondary">{t("dashboard.growthSubtitle")}</Text>
                <GrowthChart growth={growth} />
              </VStack>
            </Panel>
          )}

          {usage && <UsageSection usage={usage} formatRelative={formatRelative} />}

          {stats.sync.peers.length > 0 && (
            <Panel>
              <VStack gap={3}>
                <SectionRule label={t("dashboard.peerStatus")} />
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
            </Panel>
          )}

          <Panel>
            <VStack gap={3}>
              <SectionRule label={t("dashboard.recentSessions")} />
              {sessions === null ? (
                <Text color="secondary">{t("common.loading")}</Text>
              ) : sessions.length === 0 ? (
                <EmptyState title={t("dashboard.noSessions")} description={t("dashboard.noSessionsDesc")} />
              ) : (
                sessions.map((log) => (
                  <VStack key={log.id} gap={1}>
                    <HStack gap={3} vAlign="center">
                      <Text type="supporting" color="secondary">{log.created_at}</Text>
                      {log.project && <Tag>{log.project}</Tag>}
                    </HStack>
                    <Markdown headingLevelStart={5}>{log.summary}</Markdown>
                  </VStack>
                ))
              )}
            </VStack>
          </Panel>
        </>
      ) : null}
    </VStack>
  );
}
