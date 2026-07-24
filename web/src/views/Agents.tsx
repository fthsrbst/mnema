import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VStack, HStack, Grid } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Heading, Text } from "../components/ui/Typography";
import { StatusDot, Tag, LivePill } from "../components/ui/Tag";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { TextField, TextArea, Select } from "../components/ui/Field";
import { SectionRule } from "../components/ui/Divider";
import { Dialog } from "../components/ui/Dialog";
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

function fullTs(iso: string | null): string {
  const t = parseTs(iso);
  if (Number.isNaN(t)) return "—";
  return new Date(t).toLocaleString();
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

// Small key/value row used inside detail dialogs.
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <HStack gap={3} vAlign="start" style={{ borderTop: "1px solid var(--border)", padding: "7px 0" }}>
      <span className="u-label" style={{ flex: "0 0 118px", color: "var(--fg-dim)" }}>{label}</span>
      <div style={{ flex: "1 1 auto", minWidth: 0, wordBreak: "break-word" }}>{children}</div>
    </HStack>
  );
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
  /** YALNIZ canlı (active + stale olmayan) presence'tan gelir — bayat kayıt "şu an çalışıyor" demek değildir. */
  currentTask: string | null;
  currentProject: string | null;
  branch: string | null;
  /** Bayat/kapanmış presence'tan gelen SON görev — "çalışıyor" değil, geçmiş bilgisi. */
  lastTask: string | null;
  lastTaskProject: string | null;
  /** active kaydı var ama nabzı TTL'i geçmiş: agent muhtemelen düşmüş (checkout etmeden öldü). */
  likelyDropped: boolean;
  registered: boolean;
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
      branch: null,
      lastTask: null,
      lastTaskProject: null,
      likelyDropped: false,
      registered: true,
      uid: a.uid,
    });
  }
  // Newest heartbeat first so the first presence record we see per agent name wins.
  const sortedPresence = [...presence].sort((a, b) => parseTs(b.heartbeat_at) - parseTs(a.heartbeat_at));
  for (const p of sortedPresence) {
    // "Canlı" = checkin açık VE nabız TTL içinde. Bayat bir active kaydı, checkout
    // etmeden ölmüş bir agent'tır (presence.ts: kilit değil, TTL ile bayatlar) —
    // onu "şu an çalışıyor" diye göstermek ekranı yalan söyletir.
    const live = p.status === "active" && !p.stale;
    const existing = byName.get(p.agent);
    if (existing) {
      if (!existing.machine) existing.machine = p.machine;
      if (existing.currentTask === null && live) {
        existing.currentTask = p.task;
        existing.currentProject = p.project;
        existing.branch = p.branch;
        if (existing.status === "offline") existing.status = "busy";
      } else if (existing.currentTask === null && existing.lastTask === null) {
        existing.lastTask = p.task;
        existing.lastTaskProject = p.project;
        existing.likelyDropped = p.status === "active" && p.stale;
      }
      // Presence, registry'nin bayat "last seen" değerini tazeleyebilir.
      if (parseTs(p.heartbeat_at) > parseTs(existing.lastSeen)) existing.lastSeen = p.heartbeat_at;
    } else {
      byName.set(p.agent, {
        key: p.agent,
        name: p.agent,
        machine: p.machine,
        status: live ? "busy" : "offline",
        lastSeen: p.heartbeat_at,
        capabilities: [],
        currentTask: live ? p.task : null,
        currentProject: live ? p.project : null,
        branch: live ? p.branch : null,
        lastTask: live ? null : p.task,
        lastTaskProject: live ? null : p.project,
        likelyDropped: p.status === "active" && p.stale,
        registered: false,
        uid: null,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ============================================================================
// Agent card (roster) — clickable, opens detail
// ============================================================================
function AgentCard({ agent, onHeartbeat, onOpen }: { agent: MergedAgent; onHeartbeat: (uid: string) => void; onOpen: () => void }) {
  const { t } = useI18n();
  const offline = agent.status === "offline" && !agent.currentTask;
  return (
    <Panel style={{ opacity: offline ? 0.6 : 1, cursor: "pointer" }} onClick={onOpen}>
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
          {agent.registered ? <Tag variant="accent">MCP</Tag> : <Tag>presence</Tag>}
          <Text type="supporting" color="secondary">{t("agents.lastSeen")}: {timeAgo(agent.lastSeen)}</Text>
        </HStack>

        {agent.currentTask ? (
          <Text type="supporting" style={{ wordBreak: "break-word" }}>
            {t("agents.currentTask")}: {agent.currentTask}
            {agent.currentProject ? ` (${agent.currentProject})` : ""}
          </Text>
        ) : agent.lastTask ? (
          <VStack gap={1}>
            <Text type="supporting" color="secondary" style={{ wordBreak: "break-word" }}>
              {t("agents.lastTask")}: {agent.lastTask}
              {agent.lastTaskProject ? ` (${agent.lastTaskProject})` : ""}
            </Text>
            {agent.likelyDropped && <Tag variant="warn">{t("agents.likelyDropped")}</Tag>}
          </VStack>
        ) : (
          <Text type="supporting" color="secondary">{t("agents.noTask")}</Text>
        )}

        {agent.capabilities.length > 0 && (
          <HStack gap={1} wrap="wrap">
            {agent.capabilities.slice(0, 6).map((cap) => (
              <Tag key={cap} variant="accent">{cap}</Tag>
            ))}
          </HStack>
        )}

        {agent.uid && (
          <div onClick={(e) => e.stopPropagation()}>
            <Button label={t("agents.heartbeat")} size="sm" onClick={() => onHeartbeat(agent.uid!)} />
          </div>
        )}
      </VStack>
    </Panel>
  );
}

// Agent detail dialog: identity + related messages + claimed tasks.
function AgentDetailDialog({
  agent, messages, tasks, onClose, onOpenMessage, onOpenTask,
}: {
  agent: MergedAgent;
  messages: AgentMessage[];
  tasks: Task[];
  onClose: () => void;
  onOpenMessage: (m: AgentMessage) => void;
  onOpenTask: (t: Task) => void;
}) {
  const { t } = useI18n();
  const related = messages.filter((m) => m.from_agent === agent.name || m.to_agent === agent.name);
  const claimed = tasks.filter((tk) => tk.claimed_by === agent.name);
  return (
    <Dialog isOpen onOpenChange={(o) => { if (!o) onClose(); }} width={620} title={agent.name}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <StatusDot variant={capStatusVariant(agent.status)} label={t(`agents.cap.${agent.status}` as never)} />
          {agent.registered ? <Tag variant="accent">MCP</Tag> : <Tag>presence</Tag>}
        </HStack>
        <VStack gap={0}>
          <DetailRow label={t("agents.detailMachine")}>{agent.machine ?? "—"}</DetailRow>
          <DetailRow label={t("agents.detailTask")}>
            {agent.currentTask ?? (
              agent.lastTask
                ? <VStack gap={1}>
                    <Text color="secondary">{t("agents.lastTask")}: {agent.lastTask}</Text>
                    {agent.likelyDropped && <Tag variant="warn">{t("agents.likelyDropped")}</Tag>}
                  </VStack>
                : <Text color="secondary">{t("agents.noTask")}</Text>
            )}
          </DetailRow>
          <DetailRow label={t("agents.detailProject")}>{agent.currentProject ?? agent.lastTaskProject ?? "—"}</DetailRow>
          <DetailRow label={t("agents.detailBranch")}>{agent.branch ?? "—"}</DetailRow>
          <DetailRow label={t("agents.lastSeen")}>{timeAgo(agent.lastSeen)} · {fullTs(agent.lastSeen)}</DetailRow>
          <DetailRow label={t("agents.capabilities")}>
            {agent.capabilities.length ? (
              <HStack gap={1} wrap="wrap">{agent.capabilities.map((c) => <Tag key={c} variant="accent">{c}</Tag>)}</HStack>
            ) : "—"}
          </DetailRow>
          {agent.uid && <DetailRow label={t("agents.uid")}><span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{agent.uid}</span></DetailRow>}
        </VStack>

        <SectionRule label={`${t("agents.relatedMessages")} (${related.length})`} />
        {related.length === 0 ? (
          <Text type="supporting" color="secondary">{t("agents.none")}</Text>
        ) : (
          <VStack>
            {related.slice(0, 8).map((m) => (
              <HStack key={m.uid} gap={2} vAlign="center" wrap="wrap"
                style={{ borderTop: "1px solid var(--border)", padding: "6px 0", cursor: "pointer" }}
                onClick={() => onOpenMessage(m)}>
                <Tag variant={msgKindVariant(m.kind)}>{m.kind}</Tag>
                <Text type="supporting">{m.from_agent} → {m.to_agent ?? t("agents.broadcast")}</Text>
                <Text type="supporting" color="secondary" style={{ marginLeft: "auto" }}>{timeAgo(m.created_at)}</Text>
                <Text style={{ flexBasis: "100%", wordBreak: "break-word" }}>{m.subject}</Text>
              </HStack>
            ))}
          </VStack>
        )}

        <SectionRule label={`${t("agents.claimedTasks")} (${claimed.length})`} />
        {claimed.length === 0 ? (
          <Text type="supporting" color="secondary">{t("agents.none")}</Text>
        ) : (
          <VStack>
            {claimed.slice(0, 8).map((tk) => (
              <HStack key={tk.uid} gap={2} vAlign="center" wrap="wrap"
                style={{ borderTop: "1px solid var(--border)", padding: "6px 0", cursor: "pointer" }}
                onClick={() => onOpenTask(tk)}>
                <Tag>{tk.status}</Tag>
                <Text style={{ wordBreak: "break-word" }}>{tk.title}</Text>
                <Text type="supporting" color="secondary" style={{ marginLeft: "auto" }}>P{tk.priority}</Text>
              </HStack>
            ))}
          </VStack>
        )}
      </VStack>
    </Dialog>
  );
}

// ============================================================================
// Task board (3 columns) — cards clickable
// ============================================================================
function TaskCard({ task, onOpen }: { task: Task; onOpen: () => void }) {
  return (
    <VStack gap={1} style={{ padding: "8px 0", borderTop: "1px solid var(--border)", cursor: "pointer" }} onClick={onOpen}>
      <Text style={{ wordBreak: "break-word" }}>{task.title}</Text>
      <HStack gap={2} vAlign="center" wrap="wrap">
        {task.project && <Tag>{task.project}</Tag>}
        {task.claimed_by && <Text type="supporting" color="secondary">{task.claimed_by}</Text>}
        <Text type="supporting" color="secondary">P{task.priority}</Text>
        {task.depends_on.length > 0 && <Tag variant="warn">deps {task.depends_on.length}</Tag>}
      </HStack>
    </VStack>
  );
}

function TaskColumn({ title, tasks, onOpen }: { title: string; tasks: Task[]; onOpen: (t: Task) => void }) {
  const { t } = useI18n();
  return (
    <VStack gap={2} style={{ flex: "1 1 220px", minWidth: 0 }}>
      <span className="u-label">{title} ({tasks.length})</span>
      {tasks.length === 0 ? (
        <Text type="supporting" color="secondary">{t("agents.boardEmpty")}</Text>
      ) : (
        <VStack>{tasks.map((tk) => <TaskCard key={tk.uid} task={tk} onOpen={() => onOpen(tk)} />)}</VStack>
      )}
    </VStack>
  );
}

function TaskDetailDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog isOpen onOpenChange={(o) => { if (!o) onClose(); }} width={620} title={t("agents.taskDetailTitle")}>
      <VStack gap={3}>
        <Heading level={4} style={{ wordBreak: "break-word" }}>{task.title}</Heading>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Tag variant={task.status === "done" ? "accent" : task.status === "cancelled" ? "danger" : "default"}>{task.status}</Tag>
          {task.project && <Tag>{task.project}</Tag>}
          <Tag>P{task.priority}</Tag>
        </HStack>
        <VStack gap={0}>
          <DetailRow label={t("agents.taskDesc")}>
            {task.description ? <span style={{ whiteSpace: "pre-wrap" }}>{task.description}</span> : <Text color="secondary">{t("agents.taskNoDesc")}</Text>}
          </DetailRow>
          <DetailRow label={t("agents.taskClaimedBy")}>{task.claimed_by ?? "—"}</DetailRow>
          <DetailRow label={t("agents.taskCreatedBy")}>{task.created_by ?? "—"}</DetailRow>
          <DetailRow label={t("agents.taskDeps")}>
            {task.depends_on.length ? (
              <VStack gap={1}>{task.depends_on.map((d) => <span key={d} style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{d}</span>)}</VStack>
            ) : "—"}
          </DetailRow>
          {task.result && <DetailRow label={t("agents.taskResult")}><span style={{ whiteSpace: "pre-wrap" }}>{task.result}</span></DetailRow>}
          {task.error && <DetailRow label={t("agents.taskError")}><span style={{ whiteSpace: "pre-wrap", color: "var(--danger)" }}>{task.error}</span></DetailRow>}
          <DetailRow label={t("agents.taskCreated")}>{fullTs(task.created_at)}</DetailRow>
        </VStack>
      </VStack>
    </Dialog>
  );
}

// ============================================================================
// Message wire — rows clickable, subject wraps, body preview inline
// ============================================================================
function MessageWire({ messages, onOpen }: { messages: AgentMessage[]; onOpen: (m: AgentMessage) => void }) {
  const { t } = useI18n();
  if (messages.length === 0) {
    return <Text type="supporting" color="secondary">{t("agents.wireEmpty")}</Text>;
  }
  return (
    <VStack>
      {messages.map((m) => (
        <VStack key={m.uid} gap={1}
          style={{ padding: "8px 0", borderTop: "1px solid var(--border)", cursor: "pointer" }}
          onClick={() => onOpen(m)}>
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Tag variant={msgKindVariant(m.kind)}>{m.kind}</Tag>
            <Text type="supporting">{m.from_agent}</Text>
            <Text type="supporting" color="secondary">→</Text>
            <Text type="supporting" color="secondary">{m.to_agent ?? t("agents.broadcast")}</Text>
            {m.project && <Tag>{m.project}</Tag>}
            {m.read_at === null && m.to_agent && <StatusDot variant="warning" label={t("agents.msgUnread")} />}
            <Text type="supporting" color="secondary" style={{ marginLeft: "auto" }}>{timeAgo(m.created_at)}</Text>
          </HStack>
          <Text style={{ wordBreak: "break-word" }}>{m.subject}</Text>
          {m.body && (
            <Text type="supporting" color="secondary"
              style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
              {m.body}
            </Text>
          )}
        </VStack>
      ))}
    </VStack>
  );
}

function MessageDetailDialog({ message, onClose }: { message: AgentMessage; onClose: () => void }) {
  const { t } = useI18n();
  const hasPayload = message.payload && Object.keys(message.payload).length > 0;
  return (
    <Dialog isOpen onOpenChange={(o) => { if (!o) onClose(); }} width={640} title={t("agents.msgDetailTitle")}>
      <VStack gap={3}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Tag variant={msgKindVariant(message.kind)}>{message.kind}</Tag>
          <Text>{message.from_agent}</Text>
          <Text color="secondary">→</Text>
          <Text>{message.to_agent ?? t("agents.broadcast")}</Text>
        </HStack>
        <Heading level={4} style={{ wordBreak: "break-word" }}>{message.subject}</Heading>
        {message.body && (
          <Panel>
            <Text style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{message.body}</Text>
          </Panel>
        )}
        <VStack gap={0}>
          <DetailRow label={t("agents.msgProject")}>{message.project ?? "—"}</DetailRow>
          {message.task_uid && <DetailRow label={t("agents.msgTaskLink")}><span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{message.task_uid}</span></DetailRow>}
          <DetailRow label={t("agents.taskStatus")}>{message.to_agent ? (message.read_at ? t("agents.msgRead") : t("agents.msgUnread")) : "—"}</DetailRow>
          <DetailRow label={t("agents.msgTime")}>{fullTs(message.created_at)}</DetailRow>
          {hasPayload && (
            <DetailRow label={t("agents.msgPayload")}>
              <pre style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 11, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                {JSON.stringify(message.payload, null, 2)}
              </pre>
            </DetailRow>
          )}
        </VStack>
      </VStack>
    </Dialog>
  );
}

// ============================================================================
// Compose (collapsed behind a "Yeni mesaj" button — human broadcasting to agents)
// ============================================================================
function ComposeMessage({ agents, onSent }: { agents: MergedAgent[]; onSent: () => void }) {
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
                  options={agents.map((a) => ({ value: a.name, label: a.name }))}
                />
              </div>
              <div style={{ flex: "1 1 140px" }}>
                <Select
                  label={t("agents.msgTo")}
                  value={toAgent}
                  onChange={setToAgent}
                  placeholder={t("agents.broadcast")}
                  options={agents.filter((a) => a.name !== fromAgent).map((a) => ({ value: a.name, label: a.name }))}
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

  // Detail selections (one dialog at a time).
  const [openAgent, setOpenAgent] = useState<MergedAgent | null>(null);
  const [openTask, setOpenTask] = useState<Task | null>(null);
  const [openMessage, setOpenMessage] = useState<AgentMessage | null>(null);

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

  // Sayaçlar presence-ÖNCELİKLİ. Bu hub'daki agent'ların çoğu efemer (spawn olur,
  // işi biter, ölür) — onlar için "Toplam/Çevrimdışı" registry sayımı yanıltıcıydı:
  // ölmüş bir agent sonsuza dek "offline" olarak duruyordu. Anlamlı olan eksen
  // ZAMAN: şu an çalışan / düşmüş / son 24s biten; registry ise ayrı bir kimlik
  // listesidir ve öyle etiketlenir.
  const stats = useMemo(() => ({
    activeNow: activePresence.filter((a) => !a.stale).length,
    dropped: activePresence.filter((a) => a.stale).length,
    finished24h: recentPresence.length,
    registered: agents.length,
  }), [activePresence, recentPresence, agents]);

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
        <FleetStat label={t("agents.statActiveNow")} value={stats.activeNow} variant="success" />
        <FleetStat label={t("agents.statDropped")} value={stats.dropped} variant="warning" />
        <FleetStat label={t("agents.statFinished24h")} value={stats.finished24h} variant="neutral" />
        <FleetStat label={t("agents.statRegistered")} value={stats.registered} variant="neutral" />
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
              <AgentCard key={a.key} agent={a} onHeartbeat={handleHeartbeat} onOpen={() => setOpenAgent(a)} />
            ))}
          </Grid>
        )}
      </VStack>

      {/* 2. Görev panosu */}
      <VStack gap={3}>
        <SectionRule label={t("agents.boardTitle")} />
        <HStack gap={4} wrap="wrap" style={{ alignItems: "flex-start" }}>
          <TaskColumn title={t("agents.colPending")} tasks={board.pending} onOpen={setOpenTask} />
          <TaskColumn title={t("agents.colActive")} tasks={board.active} onOpen={setOpenTask} />
          <TaskColumn title={t("agents.colDone")} tasks={board.done} onOpen={setOpenTask} />
        </HStack>
      </VStack>

      {/* 3. Mesaj akışı */}
      <Panel>
        <VStack gap={3}>
          <SectionRule label={t("agents.wireTitle")} />
          <Text type="supporting" color="secondary">{t("agents.wireHint")}</Text>
          <ComposeMessage agents={mergedAgents} onSent={() => { void loadWire(); }} />
          <MessageWire messages={wire} onOpen={setOpenMessage} />
        </VStack>
      </Panel>

      {/* Detail dialogs */}
      {openAgent && (
        <AgentDetailDialog
          agent={openAgent}
          messages={wire}
          tasks={allTasks}
          onClose={() => setOpenAgent(null)}
          onOpenMessage={(m) => { setOpenAgent(null); setOpenMessage(m); }}
          onOpenTask={(tk) => { setOpenAgent(null); setOpenTask(tk); }}
        />
      )}
      {openTask && <TaskDetailDialog task={openTask} onClose={() => setOpenTask(null)} />}
      {openMessage && <MessageDetailDialog message={openMessage} onClose={() => setOpenMessage(null)} />}
    </VStack>
  );
}
