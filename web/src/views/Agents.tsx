import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VStack, HStack, Grid } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Heading, Text } from "../components/ui/Typography";
import { StatusDot, Tag, LivePill } from "../components/ui/Tag";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { TextField, TextArea, Select } from "../components/ui/Field";
import { SectionRule } from "../components/ui/Divider";
import { Ticker } from "../components/ui/Ticker";
import {
  fetchRegisteredAgents,
  fetchActiveAgents,
  fetchRecentAgents,
  fetchTasks,
  fetchRecentMessages,
  sendAgentMessage,
  agentHeartbeat,
  type AgentCapability,
  type AgentPresence,
  type Task,
  type AgentMessage,
} from "../api";
import { useI18n } from "../i18n";

const POLL_MS = 6000;

function parseTs(iso: string | null): number {
  if (!iso) return NaN;
  return new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z")).getTime();
}

function timeAgo(iso: string | null): string {
  const then = parseTs(iso);
  if (Number.isNaN(then)) return "—";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function capStatusVariant(status: AgentCapability["status"]): "success" | "warning" | "neutral" {
  if (status === "available") return "success";
  if (status === "busy") return "warning";
  return "neutral";
}

function msgKindVariant(kind: AgentMessage["kind"]): "default" | "accent" | "danger" | "warn" {
  if (kind === "request") return "accent";
  if (kind === "alert") return "danger";
  if (kind === "handoff") return "warn";
  return "default";
}

// ============================================================================
// Fleet stat card
// ============================================================================
function FleetStat({ label, value, variant }: { label: string; value: number; variant: "success" | "warning" | "neutral" | "error" }) {
  return (
    <Panel ticked style={{ flex: "1 1 120px" }}>
      <VStack gap={2}>
        <StatusDot variant={variant} label={label} />
        <Ticker value={value} />
      </VStack>
    </Panel>
  );
}

// ============================================================================
// Merged agent identity: agent_capabilities joined with agent_presence,
// matched on agent name (machine used only as a fallback fill-in).
// ============================================================================
interface MergedAgent {
  key: string;
  name: string;
  machine: string | null;
  status: AgentCapability["status"];
  lastSeen: string | null;
  capabilities: string[];
  currentTask: string | null;
  currentProject: string | null;
  uid: string | null;
}

function buildMergedAgents(agents: AgentCapability[], presence: AgentPresence[]): MergedAgent[] {
  const byName = new Map<string, MergedAgent>();
  for (const a of agents) {
    byName.set(a.agent, {
      key: a.agent,
      name: a.agent,
      machine: a.machine,
      status: a.status,
      lastSeen: a.last_seen_at,
      capabilities: a.capabilities,
      currentTask: null,
      currentProject: null,
      uid: a.uid,
    });
  }
  // Newest heartbeat first so the first presence record we see per agent name wins.
  const sortedPresence = [...presence].sort((a, b) => parseTs(b.heartbeat_at) - parseTs(a.heartbeat_at));
  for (const p of sortedPresence) {
    const existing = byName.get(p.agent);
    if (existing) {
      if (!existing.machine) existing.machine = p.machine;
      if (existing.currentTask === null && p.status === "active") {
        existing.currentTask = p.task;
        existing.currentProject = p.project;
      }
    } else {
      byName.set(p.agent, {
        key: p.agent,
        name: p.agent,
        machine: p.machine,
        status: p.status === "active" && !p.stale ? "busy" : "offline",
        lastSeen: p.heartbeat_at,
        capabilities: [],
        currentTask: p.status === "active" ? p.task : null,
        currentProject: p.status === "active" ? p.project : null,
        uid: null,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Agent card (roster)
// ============================================================================
function AgentCard({ agent, onHeartbeat }: { agent: MergedAgent; onHeartbeat: (uid: string) => void }) {
  const { t } = useI18n();
  const offline = agent.status === "offline" && !agent.currentTask;
  return (
    <Panel style={{ opacity: offline ? 0.55 : 1 }}>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center">
          <Heading level={4} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {agent.name}
          </Heading>
          <StatusDot
            variant={capStatusVariant(agent.status)}
            label={t(`agents.cap.${agent.status}` as never)}
            pulsing={agent.status === "available" || !!agent.currentTask}
          />
        </HStack>

        <HStack gap={2} vAlign="center" wrap="wrap">
          <Tag>{agent.machine ?? "—"}</Tag>
          <Text type="supporting" color="secondary">{t("agents.lastSeen")}: {timeAgo(agent.lastSeen)}</Text>
        </HStack>

        {agent.currentTask ? (
          <Text type="supporting">
            {t("agents.currentTask")}: {agent.currentTask}
            {agent.currentProject ? ` (${agent.currentProject})` : ""}
          </Text>
        ) : (
          <Text type="supporting" color="secondary">{t("agents.noTask")}</Text>
        )}

        {agent.capabilities.length > 0 && (
          <HStack gap={1} wrap="wrap">
            {agent.capabilities.map((cap) => (
              <Tag key={cap} variant="accent">{cap}</Tag>
            ))}
          </HStack>
        )}

        {agent.uid && (
          <Button label={t("agents.heartbeat")} size="sm" onClick={() => onHeartbeat(agent.uid!)} />
        )}
      </VStack>
    </Panel>
  );
}

// ============================================================================
// Task board (3 columns, read-only)
// ============================================================================
function TaskCard({ task }: { task: Task }) {
  return (
    <VStack gap={1} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
      <Text style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</Text>
      <HStack gap={2} vAlign="center" wrap="wrap">
        {task.project && <Tag>{task.project}</Tag>}
        {task.claimed_by && <Text type="supporting" color="secondary">{task.claimed_by}</Text>}
        <Text type="supporting" color="secondary">P{task.priority}</Text>
      </HStack>
    </VStack>
  );
}

function TaskColumn({ title, tasks }: { title: string; tasks: Task[] }) {
  const { t } = useI18n();
  return (
    <VStack gap={2} style={{ flex: "1 1 220px", minWidth: 0 }}>
      <span className="u-label">{title} ({tasks.length})</span>
      {tasks.length === 0 ? (
        <Text type="supporting" color="secondary">{t("agents.boardEmpty")}</Text>
      ) : (
        <VStack>{tasks.map((tk) => <TaskCard key={tk.uid} task={tk} />)}</VStack>
      )}
    </VStack>
  );
}

// ============================================================================
// Message wire (fleet-wide activity feed)
// ============================================================================
function MessageWire({ messages }: { messages: AgentMessage[] }) {
  const { t } = useI18n();
  if (messages.length === 0) {
    return <Text type="supporting" color="secondary">{t("agents.wireEmpty")}</Text>;
  }
  return (
    <VStack>
      {messages.map((m) => (
        <HStack key={m.uid} gap={2} vAlign="center" style={{ padding: "6px 0", borderTop: "1px solid var(--border)", flexWrap: "nowrap" }}>
          <Tag variant={msgKindVariant(m.kind)}>{m.kind}</Tag>
          <Text type="supporting" style={{ flexShrink: 0 }}>{m.from_agent}</Text>
          <Text type="supporting" color="secondary" style={{ flexShrink: 0 }}>→</Text>
          <Text type="supporting" color="secondary" style={{ flexShrink: 0 }}>{m.to_agent ?? t("agents.broadcast")}</Text>
          <Text style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{m.subject}</Text>
          <Text type="supporting" color="secondary" style={{ flexShrink: 0, marginLeft: "auto" }}>{timeAgo(m.created_at)}</Text>
        </HStack>
      ))}
    </VStack>
  );
}

// ============================================================================
// Compose (collapsed behind a "Yeni mesaj" button — human broadcasting to agents)
// ============================================================================
function ComposeMessage({ agents, onSent }: { agents: AgentCapability[]; onSent: () => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [fromAgent, setFromAgent] = useState("");
  const [toAgent, setToAgent] = useState("");
  const [kind, setKind] = useState<AgentMessage["kind"]>("info");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    if (!subject.trim() || !fromAgent) return;
    setSending(true);
    try {
      await sendAgentMessage({
        from_agent: fromAgent,
        to_agent: toAgent || undefined,
        kind,
        subject: subject.trim(),
        body: body.trim(),
      });
      setSubject("");
      setBody("");
      setToAgent("");
      setOpen(false);
      onSent();
    } catch { /* ignore */ }
    setSending(false);
  };

  return (
    <VStack gap={3}>
      <Button label={t("agents.newMessage")} variant="primary" size="sm" onClick={() => setOpen(!open)} />
      {open && (
        <Panel raised>
          <VStack gap={3}>
            <span className="u-label">{t("agents.compose")}</span>
            <HStack gap={2} wrap="wrap">
              <div style={{ flex: "1 1 140px" }}>
                <Select
                  label={t("agents.msgFrom")}
                  value={fromAgent}
                  onChange={setFromAgent}
                  options={agents.map((a) => ({ value: a.agent, label: a.agent }))}
                />
              </div>
              <div style={{ flex: "1 1 140px" }}>
                <Select
                  label={t("agents.msgTo")}
                  value={toAgent}
                  onChange={setToAgent}
                  placeholder={t("agents.broadcast")}
                  options={agents.filter((a) => a.agent !== fromAgent).map((a) => ({ value: a.agent, label: a.agent }))}
                />
              </div>
              <div style={{ flex: "1 1 110px" }}>
                <Select
                  label={t("agents.msgKind")}
                  value={kind}
                  onChange={(v) => setKind(v as AgentMessage["kind"])}
                  options={["info", "request", "response", "handoff", "alert"].map((k) => ({ value: k, label: k }))}
                />
              </div>
            </HStack>
            <TextField label={t("agents.msgSubject")} value={subject} onChange={setSubject} placeholder="..." />
            <TextArea label={t("agents.msgBody")} value={body} onChange={setBody} rows={3} />
            <HStack gap={2}>
              <Button label={t("common.save")} variant="primary" onClick={handleSend} disabled={sending || !subject.trim() || !fromAgent} />
              <Button label={t("common.cancel")} onClick={() => setOpen(false)} />
            </HStack>
          </VStack>
        </Panel>
      )}
    </VStack>
  );
}

// ============================================================================
// Main view
// ============================================================================
export function Agents() {
  const { t } = useI18n();
  const [agents, setAgents] = useState<AgentCapability[]>([]);
  const [activePresence, setActivePresence] = useState<AgentPresence[]>([]);
  const [recentPresence, setRecentPresence] = useState<AgentPresence[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [wire, setWire] = useState<AgentMessage[]>([]);
  const [connLost, setConnLost] = useState(false);
  const hasLoadedOnce = useRef(false);

  const loadWire = useCallback(async () => {
    try {
      setWire(await fetchRecentMessages(30));
    } catch { /* ignore */ }
  }, []);

  const poll = useCallback(async () => {
    try {
      const [regs, active, recent, tasks] = await Promise.all([
        fetchRegisteredAgents(),
        fetchActiveAgents(),
        fetchRecentAgents(24),
        fetchTasks(),
      ]);
      setAgents(regs);
      setActivePresence(active);
      setRecentPresence(recent);
      setAllTasks(tasks);
      setConnLost(false);
      hasLoadedOnce.current = true;
    } catch {
      setConnLost(true);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    let timer: number;
    const loop = async () => {
      await poll();
      await loadWire();
      if (alive) timer = window.setTimeout(loop, POLL_MS);
    };
    loop();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [poll, loadWire]);

  const handleHeartbeat = useCallback(async (uid: string) => {
    try {
      await agentHeartbeat(uid);
      await poll();
    } catch { /* ignore */ }
  }, [poll]);

  const allPresence = useMemo(
    () => [...activePresence, ...recentPresence.filter((r) => !activePresence.some((a) => a.uid === r.uid))],
    [activePresence, recentPresence]
  );

  const mergedAgents = useMemo(() => buildMergedAgents(agents, allPresence), [agents, allPresence]);

  const stats = useMemo(() => ({
    total: agents.length,
    available: agents.filter((a) => a.status === "available").length,
    busy: agents.filter((a) => a.status === "busy").length,
    offline: agents.filter((a) => a.status === "offline").length,
    activeNow: activePresence.filter((a) => !a.stale).length,
  }), [agents, activePresence]);

  const board = useMemo(() => {
    const pending = allTasks.filter((tk) => tk.status === "pending");
    const active = allTasks.filter((tk) => ["claimed", "in_progress", "blocked"].includes(tk.status));
    const done = [...allTasks.filter((tk) => tk.status === "done")]
      .sort((a, b) => parseTs(b.updated_at) - parseTs(a.updated_at))
      .slice(0, 10);
    return { pending, active, done };
  }, [allTasks]);

  return (
    <VStack gap={5}>
      {/* Header */}
      <HStack hAlign="between" vAlign="center" wrap="wrap" style={{ gap: 12 }}>
        <VStack gap={1}>
          <HStack gap={3} vAlign="center">
            <Heading level={3}>{t("agents.fleetTitle")}</Heading>
            {stats.activeNow > 0 && <LivePill>{stats.activeNow} {t("agents.runningBadge")}</LivePill>}
          </HStack>
          <Text type="supporting" color="secondary">{t("agents.fleetSubtitle")}</Text>
        </VStack>
        {connLost && <StatusDot variant="error" label={t("agents.connectionLost")} />}
      </HStack>

      {/* Fleet stats */}
      <HStack gap={4} wrap="wrap">
        <FleetStat label={t("agents.statTotal")} value={stats.total} variant="neutral" />
        <FleetStat label={t("agents.statAvailable")} value={stats.available} variant="success" />
        <FleetStat label={t("agents.statBusy")} value={stats.busy} variant="warning" />
        <FleetStat label={t("agents.statOffline")} value={stats.offline} variant="neutral" />
        <FleetStat label={t("agents.statActiveNow")} value={stats.activeNow} variant="success" />
      </HStack>

      {/* 1. Ajanlar */}
      <VStack gap={3}>
        <SectionRule label={t("agents.rosterTitle")} />
        {!hasLoadedOnce.current ? (
          <Text type="supporting" color="secondary">{t("common.loading")}</Text>
        ) : mergedAgents.length === 0 ? (
          <Panel>
            <EmptyState title={t("agents.rosterEmpty")} description={t("agents.rosterEmptyDesc")} />
          </Panel>
        ) : (
          <Grid minWidth={280} gap={4}>
            {mergedAgents.map((a) => (
              <AgentCard key={a.key} agent={a} onHeartbeat={handleHeartbeat} />
            ))}
          </Grid>
        )}
      </VStack>

      {/* 2. Görev panosu */}
      <VStack gap={3}>
        <SectionRule label={t("agents.boardTitle")} />
        <HStack gap={4} wrap="wrap" style={{ alignItems: "flex-start" }}>
          <TaskColumn title={t("agents.colPending")} tasks={board.pending} />
          <TaskColumn title={t("agents.colActive")} tasks={board.active} />
          <TaskColumn title={t("agents.colDone")} tasks={board.done} />
        </HStack>
      </VStack>

      {/* 3. Mesaj akışı */}
      <Panel>
        <VStack gap={3}>
          <SectionRule label={t("agents.wireTitle")} />
          <ComposeMessage agents={agents} onSent={() => { void loadWire(); }} />
          <MessageWire messages={wire} />
        </VStack>
      </Panel>
    </VStack>
  );
}
