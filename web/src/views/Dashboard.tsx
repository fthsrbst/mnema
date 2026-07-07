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

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "hiç";
  const then = new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z")).getTime();
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "az önce";
  if (mins < 60) return `${mins} dk önce`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} sa önce`;
  const days = Math.floor(hours / 24);
  return `${days} gün önce`;
}

export function Dashboard() {
  const [stats, setStats] = useState<RagStats | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [sessions, setSessions] = useState<SessionLog[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

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
          <Heading level={3}>Panel</Heading>
          <Text type="supporting" color="secondary">Ortak hafıza sisteminin genel durumu</Text>
        </VStack>
        <Button label="Yenile" variant="secondary" onClick={load} isDisabled={loading} />
      </HStack>

      {error && (
        <Card variant="red">
          <Text color="secondary">Panel yüklenemedi: {error}</Text>
        </Card>
      )}

      {loading && !stats ? (
        <Text color="secondary">Yükleniyor...</Text>
      ) : stats ? (
        <>
          <Grid columns={{ minWidth: 260, repeat: "fit" }} gap={4}>
            <Card>
              <VStack gap={2}>
                <HStack hAlign="between" vAlign="center">
                  <Text type="supporting" color="secondary">Sunucu</Text>
                  <StatusDot
                    variant={health?.ok ? "success" : "error"}
                    label={health?.ok ? "Çalışıyor" : "Erişilemiyor"}
                    isPulsing={!!health?.ok}
                  />
                </HStack>
                <Heading level={4}>{health?.ok ? "Çevrimiçi" : "Kapalı"}</Heading>
                <Text type="supporting" color="secondary">v{health?.version ?? "?"}</Text>
              </VStack>
            </Card>

            <Card>
              <VStack gap={2}>
                <Text type="supporting" color="secondary">Veritabanı</Text>
                <Heading level={4}>{formatBytes(stats.db_size_bytes)}</Heading>
                <Text type="supporting" color="secondary" style={{ wordBreak: "break-all" }}>{stats.db_path}</Text>
              </VStack>
            </Card>

            <Card>
              <VStack gap={2}>
                <HStack hAlign="between" vAlign="center">
                  <Text type="supporting" color="secondary">Vektör arama</Text>
                  <StatusDot
                    variant={stats.vec_available ? "success" : "warning"}
                    label={stats.vec_available ? "Aktif" : "FTS-only"}
                  />
                </HStack>
                <Heading level={4}>{stats.vec_available ? "sqlite-vec aktif" : "Sadece anahtar kelime"}</Heading>
                <Text type="supporting" color="secondary">
                  {stats.embeddings_enabled ? `${stats.embedding_model} (${stats.embedding_dim}d)` : "Embedding kapalı (GEMINI_API_KEY yok)"}
                </Text>
              </VStack>
            </Card>

            <Card>
              <VStack gap={2}>
                <Text type="supporting" color="secondary">Eşitleme</Text>
                <Heading level={4}>{stats.sync.primary_url ? "Peer modu" : "Bağımsız (primary)"}</Heading>
                <Text type="supporting" color="secondary">
                  {stats.sync.primary_url || "HUB_PRIMARY_URL tanımlı değil"}
                </Text>
              </VStack>
            </Card>
          </Grid>

          <Grid columns={{ minWidth: 320, repeat: "fit" }} gap={4}>
            <Card>
              <VStack gap={3}>
                <Heading level={4}>Dokümanlar</Heading>
                <HStack hAlign="between">
                  <Text type="supporting" color="secondary">Toplam</Text>
                  <Text>{stats.documents.total}</Text>
                </HStack>
                <HStack hAlign="between">
                  <Text type="supporting" color="secondary">Aktif</Text>
                  <Text>{stats.documents.enabled}</Text>
                </HStack>
                <HStack hAlign="between">
                  <Text type="supporting" color="secondary">Kapalı</Text>
                  <Text>{stats.documents.disabled}</Text>
                </HStack>
              </VStack>
            </Card>

            <Card>
              <VStack gap={3}>
                <Heading level={4}>Chunk embedding oranı</Heading>
                <ProgressBar
                  label="Chunk embedding oranı"
                  isLabelHidden
                  value={stats.chunks.embedded}
                  max={Math.max(stats.chunks.total, 1)}
                  hasValueLabel
                  variant={stats.chunks.total === 0 ? "neutral" : stats.chunks.embedded === stats.chunks.total ? "success" : "warning"}
                />
                <Text type="supporting" color="secondary">
                  {stats.chunks.embedded} / {stats.chunks.total} chunk embedding'e sahip
                </Text>
              </VStack>
            </Card>

            <Card>
              <VStack gap={3}>
                <Heading level={4}>Hafıza embedding oranı</Heading>
                <ProgressBar
                  label="Hafıza embedding oranı"
                  isLabelHidden
                  value={stats.memories.embedded}
                  max={Math.max(stats.memories.total, 1)}
                  hasValueLabel
                  variant={stats.memories.total === 0 ? "neutral" : stats.memories.embedded === stats.memories.total ? "success" : "warning"}
                />
                <Text type="supporting" color="secondary">
                  {stats.memories.embedded} / {stats.memories.total} kayıt embedding'e sahip
                </Text>
              </VStack>
            </Card>
          </Grid>

          {stats.sync.peers.length > 0 && (
            <Card>
              <VStack gap={3}>
                <Heading level={4}>Peer eşitleme durumu</Heading>
                <Divider />
                {stats.sync.peers.map((p) => (
                  <HStack key={p.peer} hAlign="between" vAlign="center">
                    <Text type="supporting">{p.peer}</Text>
                    <HStack gap={4}>
                      <Text type="supporting" color="secondary">Son pull: {formatRelative(p.last_pull)}</Text>
                      <Text type="supporting" color="secondary">Son push: {formatRelative(p.last_push)}</Text>
                    </HStack>
                  </HStack>
                ))}
              </VStack>
            </Card>
          )}

          <Card>
            <VStack gap={3}>
              <HStack hAlign="between" vAlign="center">
                <Heading level={4}>Son oturumlar</Heading>
              </HStack>
              <Divider />
              {sessions === null ? (
                <Text color="secondary">Yükleniyor...</Text>
              ) : sessions.length === 0 ? (
                <EmptyState title="Henüz oturum kaydı yok" description="Agentlar oturum sonunda session_log ile özet bırakır." />
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
