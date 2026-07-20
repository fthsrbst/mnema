import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Heading, Text } from "../components/ui/Typography";
import { StatusDot, Tag } from "../components/ui/Tag";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";
import { DataTable, type Column } from "../components/ui/DataTable";
import {
  fetchMetricsOverview,
  fetchEvents,
  fetchWebhooks,
  registerWebhook,
  removeWebhook,
  fetchJobs,
  fetchJobStats,
  fetchHygieneReport,
  runHygiene,
  type MetricsOverview,
  type HubEvent,
  type Webhook,
  type Job,
  type HygieneReport,
} from "../api";
import { useI18n } from "../i18n";

const POLL_MS = 8000;

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = new Date(iso.replace(" ", "T") + (iso.endsWith("Z") ? "" : "Z")).getTime();
  if (Number.isNaN(then)) return "—";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function MetricsSection() {
  const [metrics, setMetrics] = useState<MetricsOverview | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: number;
    const loop = async () => {
      try {
        const data = await fetchMetricsOverview();
        if (alive) setMetrics(data);
      } catch { /* ignore */ }
      if (alive) timer = window.setTimeout(loop, POLL_MS);
    };
    loop();
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);

  if (!metrics) return <Text type="supporting" color="secondary">Loading metrics...</Text>;

  const cards = [
    { label: "Uptime", value: formatUptime(metrics.uptime_sec), variant: "success" as const },
    { label: "Requests", value: String(metrics.requests_total), variant: "neutral" as const },
    { label: "Errors 5xx", value: String(metrics.errors_5xx), variant: metrics.errors_5xx > 0 ? "error" as const : "success" as const },
    { label: "Embeddings", value: String(metrics.embedding_calls), variant: "neutral" as const },
    { label: "Memories", value: String(metrics.memory_count), variant: "neutral" as const },
    { label: "Tasks", value: String(metrics.task_count), variant: "neutral" as const },
    { label: "Agents", value: String(metrics.agent_count), variant: "neutral" as const },
  ];

  return (
    <VStack gap={3}>
      <span className="u-label">System Metrics</span>
      <HStack gap={3} wrap="wrap">
        {cards.map((c) => (
          <Panel key={c.label} style={{ flex: "1 1 100px" }}>
            <VStack gap={1}>
              <StatusDot variant={c.variant} label={c.label} />
              <Heading level={4}>{c.value}</Heading>
            </VStack>
          </Panel>
        ))}
      </HStack>
      <Panel>
        <HStack gap={4} wrap="wrap">
          <VStack gap={1}>
            <Text type="supporting" color="secondary">Job Queue</Text>
            <HStack gap={2}>
              <Tag>Queued: {metrics.jobs.queued}</Tag>
              <Tag>Running: {metrics.jobs.running}</Tag>
              <Tag>Done: {metrics.jobs.done}</Tag>
              <Tag>Failed: {metrics.jobs.failed}</Tag>
            </HStack>
          </VStack>
        </HStack>
      </Panel>
    </VStack>
  );
}

function EventsSection() {
  const [events, setEvents] = useState<HubEvent[]>([]);

  useEffect(() => {
    let alive = true;
    let timer: number;
    const loop = async () => {
      try {
        const data = await fetchEvents(30);
        if (alive) setEvents(data);
      } catch { /* ignore */ }
      if (alive) timer = window.setTimeout(loop, POLL_MS);
    };
    loop();
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);

  const columns: Column<HubEvent>[] = [
    { key: "type", header: "Event", render: (e) => <Tag>{e.type}</Tag> },
    { key: "payload", header: "Details", render: (e) => (
      <span style={{ display: "block", maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.85em", opacity: 0.7 }}>
        {JSON.stringify(e.payload)}
      </span>
    )},
    { key: "time", header: "Time", render: (e) => <Text type="supporting" color="secondary">{timeAgo(e.created_at)}</Text> },
  ];

  return (
    <Panel>
      <VStack gap={3}>
        <span className="u-label">Recent Events</span>
        {events.length === 0 ? (
          <Text type="supporting" color="secondary">No events yet</Text>
        ) : (
          <DataTable data={events} columns={columns} rowKey={(e) => String(e.id)} />
        )}
      </VStack>
    </Panel>
  );
}

function WebhooksSection() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [newUrl, setNewUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      setWebhooks(await fetchWebhooks());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newUrl.trim()) return;
    setAdding(true);
    try {
      await registerWebhook({ url: newUrl.trim() });
      setNewUrl("");
      await load();
    } catch { /* ignore */ }
    setAdding(false);
  };

  const handleRemove = async (uid: string) => {
    try {
      await removeWebhook(uid);
      await load();
    } catch { /* ignore */ }
  };

  const columns: Column<Webhook>[] = [
    { key: "url", header: "URL", render: (w) => (
      <span style={{ display: "block", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{w.url}</span>
    )},
    { key: "events", header: "Events", render: (w) => <Text type="supporting">{w.events.join(", ")}</Text> },
    { key: "status", header: "Status", render: (w) => (
      <StatusDot variant={w.active ? "success" : "error"} label={w.active ? "Active" : "Disabled"} />
    )},
    { key: "fails", header: "Fails", render: (w) => <Text type="supporting">{w.fail_count}</Text> },
    { key: "last", header: "Last", render: (w) => <Text type="supporting" color="secondary">{timeAgo(w.last_triggered_at)}</Text> },
    { key: "actions", header: "", render: (w) => <Button label="Remove" onClick={() => handleRemove(w.uid)} /> },
  ];

  return (
    <Panel>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center">
          <span className="u-label">Webhooks</span>
        </HStack>
        <HStack gap={2}>
          <TextField label="" value={newUrl} onChange={setNewUrl} placeholder="https://example.com/webhook" />
          <Button label="Add" variant="primary" onClick={handleAdd} disabled={adding || !newUrl.trim()} />
        </HStack>
        {webhooks.length === 0 ? (
          <Text type="supporting" color="secondary">No webhooks registered</Text>
        ) : (
          <DataTable data={webhooks} columns={columns} rowKey={(w) => w.uid} />
        )}
      </VStack>
    </Panel>
  );
}

function JobsSection() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<{ queued: number; running: number; done: number; failed: number } | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: number;
    const loop = async () => {
      try {
        const [j, s] = await Promise.all([fetchJobs(), fetchJobStats()]);
        if (alive) { setJobs(j); setStats(s); }
      } catch { /* ignore */ }
      if (alive) timer = window.setTimeout(loop, POLL_MS);
    };
    loop();
    return () => { alive = false; window.clearTimeout(timer); };
  }, []);

  const columns: Column<Job>[] = [
    { key: "kind", header: "Kind", render: (j) => <Tag>{j.kind}</Tag> },
    { key: "status", header: "Status", render: (j) => (
      <StatusDot
        variant={j.status === "done" ? "success" : j.status === "failed" ? "error" : j.status === "running" ? "warning" : "neutral"}
        label={j.status}
      />
    )},
    { key: "attempts", header: "Attempts", render: (j) => <Text type="supporting">{j.attempts}/{j.max_attempts}</Text> },
    { key: "error", header: "Error", render: (j) => (
      <span style={{ display: "block", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.85em", opacity: 0.7 }}>
        {j.last_error ?? "—"}
      </span>
    )},
    { key: "created", header: "Created", render: (j) => <Text type="supporting" color="secondary">{timeAgo(j.created_at)}</Text> },
  ];

  return (
    <Panel>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center">
          <span className="u-label">Job Queue</span>
          {stats && (
            <HStack gap={2}>
              <Tag>Q: {stats.queued}</Tag>
              <Tag>R: {stats.running}</Tag>
              <Tag>D: {stats.done}</Tag>
              <Tag>F: {stats.failed}</Tag>
            </HStack>
          )}
        </HStack>
        {jobs.length === 0 ? (
          <Text type="supporting" color="secondary">No jobs</Text>
        ) : (
          <DataTable data={jobs.slice(0, 20)} columns={columns} rowKey={(j) => j.uid} />
        )}
      </VStack>
    </Panel>
  );
}

function HygieneSection() {
  const [report, setReport] = useState<HygieneReport | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setReport(await fetchHygieneReport());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleRun = async () => {
    setRunning(true);
    try {
      const res = await runHygiene();
      setResult(`Archived: ${res.archived}, Consolidated: ${res.consolidated}`);
      await load();
    } catch { /* ignore */ }
    setRunning(false);
  };

  return (
    <Panel>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="center">
          <span className="u-label">Memory Hygiene</span>
          <Button label="Run Hygiene" variant="primary" onClick={handleRun} disabled={running} />
        </HStack>
        {result && <Text type="supporting">{result}</Text>}
        {report && (
          <HStack gap={4} wrap="wrap">
            <VStack gap={1}>
              <StatusDot variant={report.duplicates.count > 0 ? "warning" : "success"} label={`Duplicates: ${report.duplicates.count}`} />
            </VStack>
            <VStack gap={1}>
              <StatusDot variant={report.stale.count > 0 ? "warning" : "success"} label={`Stale: ${report.stale.count}`} />
            </VStack>
            <VStack gap={1}>
              <StatusDot variant={report.contradictions.count > 0 ? "error" : "success"} label={`Contradictions: ${report.contradictions.count}`} />
            </VStack>
          </HStack>
        )}
        {report?.suggestions && report.suggestions.length > 0 && (
          <VStack gap={1}>
            {report.suggestions.map((s, i) => (
              <Text key={i} type="supporting" color="secondary">• {s}</Text>
            ))}
          </VStack>
        )}
      </VStack>
    </Panel>
  );
}

export function System() {
  const { t } = useI18n();

  return (
    <VStack gap={5}>
      <VStack gap={1}>
        <Heading level={3}>{t("system.title")}</Heading>
        <Text type="supporting" color="secondary">{t("system.subtitle")}</Text>
      </VStack>

      <MetricsSection />
      <HygieneSection />
      <WebhooksSection />
      <JobsSection />
      <EventsSection />
    </VStack>
  );
}
