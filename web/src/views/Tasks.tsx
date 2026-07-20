import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Heading, Text } from "../components/ui/Typography";
import { StatusDot, Tag } from "../components/ui/Tag";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { Select, TextField } from "../components/ui/Field";
import { DataTable, type Column } from "../components/ui/DataTable";
import {
  fetchTasks,
  createTask,
  claimTask,
  completeTask,
  cancelTask,
  type Task,
} from "../api";
import { useI18n } from "../i18n";

const POLL_MS = 5000;

function statusVariant(status: Task["status"]): "success" | "warning" | "neutral" | "error" {
  switch (status) {
    case "done": return "success";
    case "in_progress":
    case "claimed": return "warning";
    case "blocked":
    case "cancelled": return "error";
    default: return "neutral";
  }
}

function statusLabel(status: Task["status"]): string {
  const labels: Record<Task["status"], string> = {
    pending: "Pending",
    claimed: "Claimed",
    in_progress: "In Progress",
    blocked: "Blocked",
    done: "Done",
    cancelled: "Cancelled",
  };
  return labels[status];
}

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

export function Tasks() {
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [projectFilter, setProjectFilter] = useState<string>("");
  const [showCreate, setShowCreate] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newProject, setNewProject] = useState("");
  const [newPriority, setNewPriority] = useState("0");
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchTasks(projectFilter || undefined, statusFilter || undefined);
      setTasks(data);
    } catch { /* ignore */ }
  }, [projectFilter, statusFilter]);

  useEffect(() => {
    let alive = true;
    let timer: number;
    const loop = async () => {
      await load();
      if (alive) timer = window.setTimeout(loop, POLL_MS);
    };
    loop();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [load]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    setCreating(true);
    try {
      await createTask({
        title: newTitle.trim(),
        project: newProject.trim() || undefined,
        priority: Number(newPriority) || 0,
        created_by: "web-ui",
      });
      setNewTitle("");
      setNewProject("");
      setNewPriority("0");
      setShowCreate(false);
      await load();
    } catch { /* ignore */ }
    setCreating(false);
  };

  const handleClaim = async (uid: string) => {
    try {
      await claimTask(uid, "web-ui");
      await load();
    } catch { /* ignore */ }
  };

  const handleComplete = async (uid: string) => {
    try {
      await completeTask(uid);
      await load();
    } catch { /* ignore */ }
  };

  const handleCancel = async (uid: string) => {
    try {
      await cancelTask(uid, "Cancelled from UI");
      await load();
    } catch { /* ignore */ }
  };

  const selectedTask = tasks.find((tk) => tk.uid === selected) ?? null;

  const counts = {
    pending: tasks.filter((tk) => tk.status === "pending").length,
    active: tasks.filter((tk) => tk.status === "claimed" || tk.status === "in_progress").length,
    done: tasks.filter((tk) => tk.status === "done").length,
    blocked: tasks.filter((tk) => tk.status === "blocked").length,
  };

  const columns: Column<Task>[] = [
    { key: "title", header: "Title", render: (tk) => (
      <span style={{ display: "block", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {tk.title}
      </span>
    )},
    { key: "project", header: "Project", render: (tk) => tk.project ? <Tag>{tk.project}</Tag> : <Text type="supporting" color="secondary">—</Text> },
    { key: "status", header: "Status", render: (tk) => <StatusDot variant={statusVariant(tk.status)} label={statusLabel(tk.status)} /> },
    { key: "priority", header: "Priority", render: (tk) => <Text type="supporting">{tk.priority}</Text> },
    { key: "claimed_by", header: "Agent", render: (tk) => <Text type="supporting">{tk.claimed_by ?? "—"}</Text> },
    { key: "updated", header: "Updated", render: (tk) => <Text type="supporting" color="secondary">{timeAgo(tk.updated_at)}</Text> },
  ];

  return (
    <VStack gap={5}>
      <HStack hAlign="between" vAlign="center">
        <VStack gap={1}>
          <Heading level={3}>{t("tasks.title")}</Heading>
          <Text type="supporting" color="secondary">{t("tasks.subtitle")}</Text>
        </VStack>
        <Button label={t("tasks.create")} variant="primary" onClick={() => setShowCreate(!showCreate)} />
      </HStack>

      {/* Summary cards */}
      <HStack gap={4} wrap="wrap">
        {([
          { label: "Pending", value: counts.pending, variant: "neutral" as const },
          { label: "Active", value: counts.active, variant: "warning" as const },
          { label: "Done", value: counts.done, variant: "success" as const },
          { label: "Blocked", value: counts.blocked, variant: "error" as const },
        ]).map((s) => (
          <Panel key={s.label} style={{ flex: "1 1 120px" }}>
            <VStack gap={1}>
              <StatusDot variant={s.variant} label={s.label} />
              <Heading level={3}>{s.value}</Heading>
            </VStack>
          </Panel>
        ))}
      </HStack>

      {/* Create form */}
      {showCreate && (
        <Panel raised>
          <VStack gap={3}>
            <span className="u-label">{t("tasks.newTask")}</span>
            <TextField label="Title" value={newTitle} onChange={setNewTitle} placeholder="Task title..." />
            <HStack gap={3} wrap="wrap">
              <TextField label="Project" value={newProject} onChange={setNewProject} placeholder="optional" />
              <TextField label="Priority" value={newPriority} onChange={setNewPriority} placeholder="0" />
            </HStack>
            <HStack gap={2}>
              <Button label={t("common.save")} variant="primary" onClick={handleCreate} disabled={creating || !newTitle.trim()} />
              <Button label={t("common.cancel")} onClick={() => setShowCreate(false)} />
            </HStack>
          </VStack>
        </Panel>
      )}

      {/* Filters */}
      <HStack gap={3} wrap="wrap">
        <Select
          label=""
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: "", label: "All statuses" },
            { value: "pending", label: "Pending" },
            { value: "claimed", label: "Claimed" },
            { value: "in_progress", label: "In Progress" },
            { value: "blocked", label: "Blocked" },
            { value: "done", label: "Done" },
            { value: "cancelled", label: "Cancelled" },
          ]}
        />
        <TextField label="" value={projectFilter} onChange={setProjectFilter} placeholder="Filter by project..." />
      </HStack>

      {/* Task list + detail */}
      <HStack gap={4} wrap="wrap" style={{ alignItems: "stretch" }}>
        <div style={{ flex: "3 1 480px", minWidth: 0 }}>
          <Panel>
            <VStack gap={3}>
              <span className="u-label">{t("tasks.list")}</span>
              {tasks.length === 0 ? (
                <EmptyState title={t("tasks.empty")} description={t("tasks.emptyDesc")} />
              ) : (
                <DataTable
                  data={tasks}
                  columns={columns}
                  rowKey={(tk) => tk.uid}
                  onRowClick={(tk) => setSelected(tk.uid)}
                  isRowActive={(tk) => tk.uid === selected}
                />
              )}
            </VStack>
          </Panel>
        </div>

        <div style={{ flex: "1 1 280px", minWidth: 0 }}>
          <Panel>
            <VStack gap={3}>
              <span className="u-label">{t("tasks.detail")}</span>
              {!selectedTask ? (
                <Text type="supporting" color="secondary">{t("tasks.detailEmpty")}</Text>
              ) : (
                <VStack gap={2}>
                  <Text>{selectedTask.title}</Text>
                  {selectedTask.description && (
                    <Text type="supporting" color="secondary">{selectedTask.description}</Text>
                  )}
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">Status</Text>
                    <StatusDot variant={statusVariant(selectedTask.status)} label={statusLabel(selectedTask.status)} />
                  </HStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">Project</Text>
                    <Text type="supporting">{selectedTask.project ?? "—"}</Text>
                  </HStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">Priority</Text>
                    <Text type="supporting">{selectedTask.priority}</Text>
                  </HStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">Created by</Text>
                    <Text type="supporting">{selectedTask.created_by ?? "—"}</Text>
                  </HStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">Claimed by</Text>
                    <Text type="supporting">{selectedTask.claimed_by ?? "—"}</Text>
                  </HStack>
                  <HStack hAlign="between">
                    <Text type="supporting" color="secondary">Created</Text>
                    <Text type="supporting">{timeAgo(selectedTask.created_at)}</Text>
                  </HStack>
                  {selectedTask.tags.length > 0 && (
                    <HStack gap={1} wrap="wrap">
                      {selectedTask.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}
                    </HStack>
                  )}
                  {selectedTask.result && (
                    <VStack gap={1}>
                      <Text type="supporting" color="secondary">Result</Text>
                      <Text type="supporting">{selectedTask.result}</Text>
                    </VStack>
                  )}
                  {selectedTask.error && (
                    <VStack gap={1}>
                      <Text type="supporting" color="secondary">Error</Text>
                      <Text type="supporting">{selectedTask.error}</Text>
                    </VStack>
                  )}
                  {/* Actions */}
                  <HStack gap={2} wrap="wrap" style={{ marginTop: 8 }}>
                    {(selectedTask.status === "pending") && (
                      <Button label="Claim" variant="primary" onClick={() => handleClaim(selectedTask.uid)} />
                    )}
                    {(selectedTask.status === "claimed" || selectedTask.status === "in_progress") && (
                      <Button label="Complete" variant="primary" onClick={() => handleComplete(selectedTask.uid)} />
                    )}
                    {selectedTask.status !== "done" && selectedTask.status !== "cancelled" && (
                      <Button label="Cancel" onClick={() => handleCancel(selectedTask.uid)} />
                    )}
                  </HStack>
                </VStack>
              )}
            </VStack>
          </Panel>
        </div>
      </HStack>
    </VStack>
  );
}
