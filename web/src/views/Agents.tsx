import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VStack, HStack, Grid } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Heading, Text } from "../components/ui/Typography";
import { StatusDot, Tag } from "../components/ui/Tag";
import { EmptyState } from "../components/ui/EmptyState";
import { DataTable, type Column } from "../components/ui/DataTable";
import { fetchActiveAgents, fetchRecentAgents, type AgentPresence } from "../api";
import { useI18n } from "../i18n";

const POLL_MS = 7000;

function parseTs(iso: string | null): number {
  if (!iso) return NaN;
  return new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z")).getTime();
}

function statusVariant(status: AgentPresence["status"], stale: boolean): "success" | "warning" | "neutral" | "error" {
  if (status === "active") return stale ? "warning" : "success";
  if (status === "done") return "neutral";
  return "error";
}

export function Agents() {
  const { t } = useI18n();
  const [activeAgents, setActiveAgents] = useState<AgentPresence[]>([]);
  const [recentAgents, setRecentAgents] = useState<AgentPresence[]>([]);
  const [connLost, setConnLost] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const hasLoadedOnce = useRef(false);

  function formatRelative(iso: string | null): string {
    const then = parseTs(iso);
    if (Number.isNaN(then)) return "—";
    const diffMs = Date.now() - then;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return t("agents.justNow");
    if (mins < 60) return `${mins} ${t("agents.minutesAgo")}`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} ${t("agents.hoursAgo")}`;
    const days = Math.floor(hours / 24);
    return `${days} ${t("agents.daysAgo")}`;
  }

  function formatDuration(startIso: string, endIso: string | null): string {
    const start = parseTs(startIso);
    const end = endIso ? parseTs(endIso) : Date.now();
    if (Number.isNaN(start) || Number.isNaN(end)) return "—";
    const mins = Math.max(0, Math.round((end - start) / 60000));
    if (mins < 60) return `${mins} ${t("agents.durMin")}`;
    const hours = Math.floor(mins / 60);
    const rem = mins % 60;
    return `${hours} ${t("agents.durHour")} ${rem} ${t("agents.durMin")}`;
  }

  const statusLabel = (a: AgentPresence): string => {
    if (a.status === "active") return a.stale ? t("agents.statusStale") : t("agents.statusActive");
    if (a.status === "done") return t("agents.statusDone");
    return t("agents.statusAbandoned");
  };

  const poll = useCallback(async () => {
    try {
      const [active, recent] = await Promise.all([fetchActiveAgents(), fetchRecentAgents(24)]);
      setActiveAgents(active);
      setRecentAgents(recent);
      setConnLost(false);
      hasLoadedOnce.current = true;
    } catch {
      // Sunucu erişilemez/401 — son bilinen durumu koru, sadece rozet göster.
      setConnLost(true);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: number;
    const loop = async () => {
      await poll();
      if (alive) timer = window.setTimeout(loop, POLL_MS);
    };
    loop();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [poll]);

  const selectedAgent = useMemo(
    () => activeAgents.find((a) => a.uid === selected) ?? recentAgents.find((a) => a.uid === selected) ?? null,
    [activeAgents, recentAgents, selected]
  );

  const freshCount = activeAgents.filter((a) => !a.stale).length;
  const staleCount = activeAgents.length - freshCount;

  const recentColumns: Column<AgentPresence>[] = [
    { key: "machine", header: t("agents.colMachine"), render: (a) => a.machine },
    { key: "agent", header: t("agents.colAgent"), render: (a) => a.agent },
    { key: "project", header: t("agents.colProject"), render: (a) => <Tag>{a.project}</Tag> },
    { key: "task", header: t("agents.colTask"), render: (a) => <span style={{ display: "block", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.task}</span> },
    { key: "status", header: t("agents.colStatus"), render: (a) => <StatusDot variant={statusVariant(a.status, a.stale)} label={statusLabel(a)} /> },
    { key: "finished", header: t("agents.colFinished"), render: (a) => formatRelative(a.finished_at ?? a.updated_at) },
  ];

  const summary: { label: string; value: number; variant: "success" | "warning" | "neutral" }[] = [
    { label: t("agents.summaryActive"), value: freshCount, variant: "success" },
    { label: t("agents.summaryStale"), value: staleCount, variant: "warning" },
    { label: t("agents.summaryFinished"), value: recentAgents.length, variant: "neutral" },
  ];

  return (
    <VStack gap={5}>
      <HStack hAlign="between" vAlign="center">
        <VStack gap={1}>
          <Heading level={3}>{t("agents.title")}</Heading>
          <Text type="supporting" color="secondary">{t("agents.subtitle")}</Text>
        </VStack>
        {connLost && <StatusDot variant="error" label={t("agents.connectionLost")} />}
      </HStack>

      <HStack gap={4} wrap="wrap">
        {summary.map((s) => (
          <Panel key={s.label} style={{ flex: "1 1 140px" }}>
            <VStack gap={1}>
              <StatusDot variant={s.variant} label={s.label} />
              <Heading level={3}>{s.value}</Heading>
            </VStack>
          </Panel>
        ))}
      </HStack>

      <HStack gap={4} wrap="wrap" style={{ alignItems: "stretch" }}>
        <div style={{ flex: "3 1 480px", minWidth: 0 }}>
          <VStack gap={3}>
            <span className="u-label">{t("agents.liveTitle")}</span>
            {activeAgents.length === 0 ? (
              <Panel>
                <EmptyState title={t("agents.empty")} description={t("agents.emptyDesc")} />
              </Panel>
            ) : (
              <Grid minWidth={280} gap={4}>
                {activeAgents.map((a) => (
                  <Panel
                    key={a.uid}
                    className={[
                      "agent-card",
                      a.stale && "agent-card--stale",
                      a.uid === selected && "agent-card--selected",
                    ].filter(Boolean).join(" ")}
                    onClick={() => setSelected(a.uid)}
                  >
                    <VStack gap={2}>
                      <HStack hAlign="between" vAlign="center">
                        <Text>{a.machine}</Text>
                        <StatusDot
                          variant={statusVariant(a.status, a.stale)}
                          label={statusLabel(a)}
                          pulsing={a.status === "active" && !a.stale}
                        />
                      </HStack>
                      <HStack gap={2} vAlign="center" wrap="wrap">
                        <Tag>{a.project}</Tag>
                        <Text type="supporting" color="secondary">{a.branch ?? t("agents.noBranch")}</Text>
                      </HStack>
                      <Text type="supporting">{a.task}</Text>
                      <HStack hAlign="between">
                        <Text type="supporting" color="secondary">{formatRelative(a.heartbeat_at)}</Text>
                        <Text type="supporting" color="secondary">{formatDuration(a.started_at, a.finished_at)}</Text>
                      </HStack>
                    </VStack>
                  </Panel>
                ))}
              </Grid>
            )}
          </VStack>
        </div>

        <div style={{ flex: "1 1 260px", minWidth: 0 }}>
          <Panel>
            <VStack gap={3}>
              <span className="u-label">{t("agents.detailTitle")}</span>
              {!selectedAgent ? (
                <Text type="supporting" color="secondary">{t("agents.detailEmpty")}</Text>
              ) : (
                <VStack gap={2}>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">{t("agents.detailMachine")}</Text>
                    <Text type="supporting">{selectedAgent.machine}</Text>
                  </HStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">{t("agents.detailAgentLabel")}</Text>
                    <Text type="supporting">{selectedAgent.agent}</Text>
                  </HStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">{t("agents.detailProject")}</Text>
                    <Tag>{selectedAgent.project}</Tag>
                  </HStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">{t("agents.detailBranch")}</Text>
                    <Text type="supporting">{selectedAgent.branch ?? t("agents.noBranch")}</Text>
                  </HStack>
                  <VStack gap={1}>
                    <Text type="supporting" color="secondary">{t("agents.detailTask")}</Text>
                    <Text type="supporting">{selectedAgent.task}</Text>
                  </VStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">{t("agents.detailStarted")}</Text>
                    <Text type="supporting">{formatRelative(selectedAgent.started_at)}</Text>
                  </HStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">{t("agents.detailHeartbeat")}</Text>
                    <Text type="supporting">{formatRelative(selectedAgent.heartbeat_at)}</Text>
                  </HStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">{t("agents.detailDuration")}</Text>
                    <Text type="supporting">{formatDuration(selectedAgent.started_at, selectedAgent.finished_at)}</Text>
                  </HStack>
                  <HStack hAlign="between" vAlign="center">
                    <Text type="supporting" color="secondary">{t("agents.detailStatus")}</Text>
                    <StatusDot variant={statusVariant(selectedAgent.status, selectedAgent.stale)} label={statusLabel(selectedAgent)} pulsing={selectedAgent.status === "active" && !selectedAgent.stale} />
                  </HStack>
                </VStack>
              )}
            </VStack>
          </Panel>
        </div>
      </HStack>

      <Panel>
        <VStack gap={3}>
          <span className="u-label">{t("agents.recentTitle")}</span>
          {recentAgents.length === 0 ? (
            <Text type="supporting" color="secondary">{t("agents.recentEmpty")}</Text>
          ) : (
            <DataTable
              data={recentAgents}
              columns={recentColumns}
              rowKey={(a) => a.uid}
              onRowClick={(a) => setSelected(a.uid)}
              isRowActive={(a) => a.uid === selected}
            />
          )}
        </VStack>
      </Panel>
    </VStack>
  );
}
