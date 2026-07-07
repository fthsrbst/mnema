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
import { api, type HealthStatus, type RagStats, type SessionLog } from "../api";
import { useI18n } from "../i18n";

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function Dashboard() {
  const { t } = useI18n();
  const [stats, setStats] = useState<RagStats | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [sessions, setSessions] = useState<SessionLog[] | null>(null);
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
      const [s, h, sess] = await Promise.all([
        api<RagStats>("GET", "/api/rag/stats"),
        fetch("/health").then((r) => r.json() as Promise<HealthStatus>),
        api<SessionLog[]>("GET", "/api/sessions?limit=5"),
      ]);
      setStats(s);
      setHealth(h);
      setSessions(sess);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
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
                    <Text type="supporting">{log.summary}</Text>
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
