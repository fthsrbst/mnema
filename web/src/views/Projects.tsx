import { useEffect, useState } from "react";
import { VStack, HStack, Grid } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { TextField, TextArea, Select } from "../components/ui/Field";
import { Heading, Text } from "../components/ui/Typography";
import { StatusDot, Tag } from "../components/ui/Tag";
import { EmptyState } from "../components/ui/EmptyState";
import { AlertDialog, Dialog } from "../components/ui/Dialog";
import { SectionRule } from "../components/ui/Divider";
import { DataTable, type Column } from "../components/ui/DataTable";
import { useToast } from "../components/ui/useToast";
import {
  api,
  fetchActiveAgents,
  fetchGraphNeighbors,
  type AgentPresence,
  type GraphPayload,
  type Memory,
  type ProjectMap,
  type ProjectModule,
  type RagDocument,
  type SessionLog,
} from "../api";
import { useI18n } from "../i18n";
import { Markdown } from "../components/Markdown";

const STATUS_OPTIONS = ["active", "paused", "done", "idea"];

function statusVariant(s: string | undefined): "success" | "warning" | "neutral" | "error" {
  return s === "active" ? "success" : s === "paused" ? "warning" : s === "done" ? "neutral" : "neutral";
}

/** Proje kartlarında/detayında "N agent çalışıyor" rozeti — 1-bit estetiğe uygun, emoji yok. */
function ProjectAgentsBadge({ agents }: { agents: AgentPresence[] }) {
  const { t } = useI18n();
  if (agents.length === 0) return null;
  const fresh = agents.some((a) => !a.stale);
  return (
    <span className="project-agents-badge">
      <StatusDot variant={fresh ? "success" : "warning"} label={`${agents.length} ${t("projects.agentsRunning")}`} pulsing={fresh} />
    </span>
  );
}

/** Kod haritası alanları (mimari, modüller, komutlar vb.) — backend'de opsiyonel, doluysa gösterilir. */
function CodeMapSection({ project }: { project: ProjectMap }) {
  const { t } = useI18n();
  const hasAny =
    project.architecture ||
    (project.modules?.length ?? 0) > 0 ||
    (project.entry_points && Object.keys(project.entry_points).length > 0) ||
    (project.commands && Object.keys(project.commands).length > 0) ||
    (project.conventions?.length ?? 0) > 0 ||
    project.data_model;

  if (!hasAny) return null;

  const moduleColumns: Column<ProjectModule>[] = [
    { key: "name", header: t("projects.moduleName"), width: "160px", render: (m) => m.name },
    { key: "path", header: t("projects.modulePath"), width: "200px", render: (m) => <code style={{ fontSize: 11 }}>{m.path}</code> },
    { key: "purpose", header: t("projects.modulePurpose"), render: (m) => m.purpose },
    {
      key: "depends",
      header: t("projects.moduleDependsOn"),
      width: "160px",
      render: (m) => (m.depends_on?.length ? m.depends_on.join(", ") : "—"),
    },
  ];

  return (
    <Panel>
      <VStack gap={4}>
        <SectionRule label={t("projects.architecture")} />
        {project.architecture && <Markdown headingLevelStart={5}>{project.architecture}</Markdown>}

        {(project.modules?.length ?? 0) > 0 && (
          <VStack gap={2}>
            <span className="u-label">{t("projects.modules")}</span>
            <DataTable data={project.modules!} columns={moduleColumns} rowKey={(m) => m.name} />
          </VStack>
        )}

        {project.entry_points && Object.keys(project.entry_points).length > 0 && (
          <VStack gap={2}>
            <span className="u-label">{t("projects.entryPoints")}</span>
            <VStack gap={1}>
              {Object.entries(project.entry_points).map(([k, v]) => (
                <HStack key={k} gap={3}>
                  <code style={{ fontSize: 11, color: "var(--fg-dim)", minWidth: 100 }}>{k}</code>
                  <code style={{ fontSize: 11 }}>{v}</code>
                </HStack>
              ))}
            </VStack>
          </VStack>
        )}

        {project.commands && Object.keys(project.commands).length > 0 && (
          <VStack gap={2}>
            <span className="u-label">{t("projects.commands")}</span>
            <VStack gap={1}>
              {Object.entries(project.commands).map(([k, v]) => (
                <HStack key={k} gap={3} vAlign="start">
                  <code style={{ fontSize: 11, color: "var(--fg-dim)", minWidth: 100 }}>{k}</code>
                  <code style={{ fontSize: 11 }}>{v}</code>
                </HStack>
              ))}
            </VStack>
          </VStack>
        )}

        {(project.conventions?.length ?? 0) > 0 && (
          <VStack gap={2}>
            <span className="u-label">{t("projects.conventions")}</span>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: "var(--fg-dim)", display: "flex", flexDirection: "column", gap: 4 }}>
              {project.conventions!.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          </VStack>
        )}

        {project.data_model && (
          <VStack gap={2}>
            <span className="u-label">{t("projects.dataModel")}</span>
            <Markdown headingLevelStart={5}>{project.data_model}</Markdown>
          </VStack>
        )}
      </VStack>
    </Panel>
  );
}

interface ProjectWorkspaceData {
  memories: Memory[];
  documents: RagDocument[];
  sessions: SessionLog[];
  graph: GraphPayload;
}

function ProjectKnowledgeSection({ data, loading }: { data: ProjectWorkspaceData | null; loading: boolean }) {
  const { t } = useI18n();
  if (loading) return <Text type="supporting" color="secondary">{t("common.loading")}</Text>;
  if (!data) return null;
  const solutions = data.memories.filter((memory) => memory.type === "howto");
  const neighbors = data.graph.nodes.filter((node) => node.kind !== "project");
  return (
    <Panel>
      <VStack gap={4}>
        <SectionRule label={t("projects.knowledgeWorkspace")} />
        <Grid minWidth={150} gap={3}>
          <VStack gap={1}><Heading level={4}>{data.documents.length}</Heading><Text type="supporting" color="secondary">{t("projects.linkedDocuments")}</Text></VStack>
          <VStack gap={1}><Heading level={4}>{data.memories.length}</Heading><Text type="supporting" color="secondary">{t("projects.linkedMemories")}</Text></VStack>
          <VStack gap={1}><Heading level={4}>{solutions.length}</Heading><Text type="supporting" color="secondary">{t("projects.solutions")}</Text></VStack>
          <VStack gap={1}><Heading level={4}>{data.sessions.length}</Heading><Text type="supporting" color="secondary">{t("projects.sessions")}</Text></VStack>
          <VStack gap={1}><Heading level={4}>{neighbors.length + data.graph.more}</Heading><Text type="supporting" color="secondary">{t("projects.graphNeighbors")}</Text></VStack>
        </Grid>

        {data.documents.length > 0 && (
          <VStack gap={2}>
            <span className="u-label">{t("projects.recentDocuments")}</span>
            {data.documents.slice(0, 6).map((document) => (
              <HStack key={document.id} hAlign="between" vAlign="center">
                <Text>{document.title}</Text>
                <Tag>{document.kind ?? "reference"}</Tag>
              </HStack>
            ))}
          </VStack>
        )}

        {solutions.length > 0 && (
          <VStack gap={2}>
            <span className="u-label">{t("projects.solutions")}</span>
            {solutions.slice(0, 6).map((solution) => (
              <VStack key={solution.id} gap={1}>
                <Text>{solution.title}</Text>
                <Text type="supporting" color="secondary">{solution.body.slice(0, 220)}</Text>
              </VStack>
            ))}
          </VStack>
        )}

        {neighbors.length > 0 && (
          <VStack gap={2}>
            <span className="u-label">{t("projects.projectGraph")}</span>
            <HStack gap={2} style={{ flexWrap: "wrap" }}>
              {neighbors.slice(0, 20).map((node) => (
                <Tag key={node.id} variant={node.kind === "memory" ? "accent" : "default"}>{node.kind}: {node.label}</Tag>
              ))}
              {data.graph.more > 0 && <Tag>+{data.graph.more}</Tag>}
            </HStack>
          </VStack>
        )}
      </VStack>
    </Panel>
  );
}

export function Projects() {
  const { t } = useI18n();
  const toast = useToast();
  const [projects, setProjects] = useState<ProjectMap[]>([]);
  const [selected, setSelected] = useState<ProjectMap | null>(null);
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState("active");
  const [stack, setStack] = useState("");
  const [focus, setFocus] = useState("");
  const [nextSteps, setNextSteps] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectMap | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [workspace, setWorkspace] = useState<ProjectWorkspaceData | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [agentsByProject, setAgentsByProject] = useState<Record<string, AgentPresence[]>>({});

  const load = async () => {
    try {
      setProjects(await api<ProjectMap[]>("GET", "/api/projects"));
    } catch (err) {
      setError((err as Error).message);
    }
    try {
      const active = await fetchActiveAgents();
      const grouped: Record<string, AgentPresence[]> = {};
      for (const a of active) (grouped[a.project] ??= []).push(a);
      setAgentsByProject(grouped);
    } catch {
      setAgentsByProject({});
    }
  };
  useEffect(() => {
    load();
  }, []);

  const loadWorkspace = async (name: string) => {
    setWorkspaceLoading(true);
    try {
      const encoded = encodeURIComponent(name);
      const [memories, documents, sessions, graph] = await Promise.all([
        api<Memory[]>("GET", `/api/memory?project=${encoded}&limit=100`),
        api<RagDocument[]>("GET", `/api/rag/documents?project=${encoded}`),
        api<SessionLog[]>("GET", `/api/sessions?project=${encoded}&limit=50`),
        fetchGraphNeighbors("project", name, 0, 50),
      ]);
      setWorkspace({ memories, documents, sessions, graph });
    } catch (err) {
      setError((err as Error).message);
      setWorkspace(null);
    } finally {
      setWorkspaceLoading(false);
    }
  };

  const open = (p: ProjectMap) => {
    setSelected(p);
    setSummary(p.summary ?? "");
    setStatus(p.status ?? "active");
    setStack((p.stack ?? []).join(", "));
    setFocus(p.current_focus ?? "");
    setNextSteps((p.next_steps ?? []).join("\n"));
    setNotes(p.notes ?? "");
    setWorkspace(null);
    void loadWorkspace(p.name);
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      await api("PUT", `/api/projects/${encodeURIComponent(selected.name)}`, {
        summary,
        status,
        stack: stack.split(",").map((s) => s.trim()).filter(Boolean),
        current_focus: focus,
        next_steps: nextSteps.split("\n").map((s) => s.trim()).filter(Boolean),
        notes,
      });
      toast({ body: t("common.savedToast"), type: "info" });
      setSelected(null);
      await load();
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const createProject = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    try {
      await api("PUT", `/api/projects/${encodeURIComponent(newName.trim())}`, {
        summary,
        status,
        stack: stack.split(",").map((s) => s.trim()).filter(Boolean),
        current_focus: focus,
        next_steps: nextSteps.split("\n").map((s) => s.trim()).filter(Boolean),
        notes,
      });
      toast({ body: t("common.createdToast"), type: "info" });
      setShowNew(false);
      setNewName("");
      setSummary("");
      setStatus("active");
      setStack("");
      setFocus("");
      setNextSteps("");
      setNotes("");
      await load();
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api("DELETE", `/api/projects/${encodeURIComponent(deleteTarget.name)}`);
      toast({ body: t("common.deletedToast"), type: "info" });
      if (selected?.name === deleteTarget.name) setSelected(null);
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast({ body: `${t("common.deleteFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setDeleting(false);
    }
  };

  if (selected) {
    return (
      <VStack gap={4}>
        <HStack gap={3} vAlign="center" hAlign="between">
          <HStack gap={3} vAlign="center">
            <Button label={t("common.back")} variant="secondary" onClick={() => setSelected(null)} />
            <Heading level={3}>{selected.name}</Heading>
            <StatusDot variant={statusVariant(selected.status)} label={selected.status ?? t("projects.unknownStatus")} />
            <ProjectAgentsBadge agents={agentsByProject[selected.name] ?? []} />
          </HStack>
          <Button label={t("common.delete")} variant="destructive" onClick={() => setDeleteTarget(selected)} />
        </HStack>
        <Panel>
          <VStack gap={3}>
            <TextArea label={t("projects.summary")} value={summary} onChange={setSummary} rows={2} />
            <HStack gap={3}>
              <Select label={t("projects.status")} value={status} onChange={setStatus} options={STATUS_OPTIONS.map((v) => ({ value: v, label: v }))} />
              <TextField label={t("projects.stack")} value={stack} onChange={setStack} optional />
            </HStack>
            {selected.repo && <Text color="secondary">Repo: {selected.repo}</Text>}
            <TextField label={t("projects.currentFocus")} value={focus} onChange={setFocus} />
            <TextArea label={t("projects.nextSteps")} value={nextSteps} onChange={setNextSteps} rows={5} />
            <TextArea label={t("projects.notes")} value={notes} onChange={setNotes} rows={3} optional />
            <Button label={saving ? t("common.saving") : t("common.save")} variant="primary" onClick={save} disabled={saving} />
          </VStack>
        </Panel>

        <CodeMapSection project={selected} />
        <ProjectKnowledgeSection data={workspace} loading={workspaceLoading} />

        {(selected.decisions?.length ?? 0) > 0 && (
          <Panel>
            <VStack gap={2}>
              <SectionRule label={t("projects.decisions")} />
              {selected.decisions!.map((d, i) => (
                <HStack key={i} gap={2} vAlign="start" style={i > 0 ? { borderTop: "1px solid var(--border)", paddingTop: 8 } : undefined}>
                  <Text type="supporting" color="secondary">›</Text>
                  <Markdown headingLevelStart={6}>{d}</Markdown>
                </HStack>
              ))}
            </VStack>
          </Panel>
        )}

        <AlertDialog
          isOpen={deleteTarget !== null}
          onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
          title={t("common.confirmDeleteTitle")}
          description={`"${deleteTarget?.name}" ${t("projects.confirmDeleteDesc")}`}
          actionLabel={t("projects.deleteAction")}
          cancelLabel={t("common.cancel")}
          loading={deleting}
          onAction={confirmDelete}
        />
      </VStack>
    );
  }

  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={3}>{t("projects.title")}</Heading>
        <Button
          label={t("projects.newProject")}
          variant="primary"
          onClick={() => {
            setNewName("");
            setSummary("");
            setStatus("active");
            setStack("");
            setFocus("");
            setNextSteps("");
            setNotes("");
            setShowNew(true);
          }}
        />
      </HStack>
      {error && <Text color="secondary">{t("common.error")}: {error}</Text>}
      {projects.length === 0 ? (
        <EmptyState title={t("projects.empty")} description={t("projects.emptyDesc")} />
      ) : (
        <Grid minWidth={280} gap={4}>
          {projects.map((p) => (
            <Panel key={p.name}>
              <VStack gap={2}>
                <HStack gap={2} vAlign="center" hAlign="between">
                  <Heading level={4}>{p.name}</Heading>
                  <StatusDot variant={statusVariant(p.status)} label={p.status ?? t("projects.unknownStatus")} />
                </HStack>
                <Text type="supporting" color="secondary">{p.summary ?? ""}</Text>
                {p.current_focus && <Text type="supporting">Odak: {p.current_focus}</Text>}
                <ProjectAgentsBadge agents={agentsByProject[p.name] ?? []} />
                <HStack gap={2}>
                  <Button label={t("common.open")} variant="secondary" size="sm" onClick={() => open(p)} />
                  <Button label={t("common.delete")} variant="ghost" size="sm" onClick={() => setDeleteTarget(p)} />
                </HStack>
              </VStack>
            </Panel>
          ))}
        </Grid>
      )}

      <Dialog isOpen={showNew} onOpenChange={setShowNew} width={520} title={t("projects.newDialogTitle")}>
        <TextField label={t("projects.name")} value={newName} onChange={setNewName} />
        <TextArea label={t("projects.summary")} value={summary} onChange={setSummary} rows={2} optional />
        <HStack gap={3}>
          <Select label={t("projects.status")} value={status} onChange={setStatus} options={STATUS_OPTIONS.map((v) => ({ value: v, label: v }))} />
          <TextField label={t("projects.stack")} value={stack} onChange={setStack} optional />
        </HStack>
        <TextField label={t("projects.currentFocus")} value={focus} onChange={setFocus} optional />
        <TextArea label={t("projects.nextSteps")} value={nextSteps} onChange={setNextSteps} rows={3} optional />
        <HStack gap={2}>
          <Button label={saving ? t("common.saving") : t("common.create")} variant="primary" onClick={createProject} disabled={saving || !newName.trim()} />
          <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowNew(false)} />
        </HStack>
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null && !selected}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("common.confirmDeleteTitle")}
        description={`"${deleteTarget?.name}" ${t("projects.confirmDeleteDesc")}`}
        actionLabel={t("projects.deleteAction")}
        cancelLabel={t("common.cancel")}
        loading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
}
