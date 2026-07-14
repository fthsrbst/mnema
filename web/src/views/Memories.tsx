import { useCallback, useEffect, useMemo, useState } from "react";
import { VStack, HStack } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { TextField, TextArea, Select } from "../components/ui/Field";
import { Heading, Text } from "../components/ui/Typography";
import { EmptyState } from "../components/ui/EmptyState";
import { AlertDialog } from "../components/ui/Dialog";
import { Tag } from "../components/ui/Tag";
import { DataTable, type Column } from "../components/ui/DataTable";
import { useToast } from "../components/ui/useToast";
import { api, type Memory, type ProjectMap } from "../api";
import { useI18n } from "../i18n";

const MEMORY_TYPES = ["fact", "preference", "decision", "howto", "context"];

const MEMORY_TYPE_TAG_VARIANT: Record<string, "accent" | "warn" | "default"> = {
  decision: "accent",
  howto: "accent",
  preference: "warn",
  context: "default",
  fact: "default",
};

export function Memories() {
  const { t } = useI18n();
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [items, setItems] = useState<Memory[]>([]);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [draft, setDraft] = useState({ title: "", body: "", type: "fact", project: "", tags: "" });
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      const projectParam = projectFilter ? `&project=${encodeURIComponent(projectFilter)}` : "";
      const route = query.trim()
        ? `/api/memory/search?q=${encodeURIComponent(query)}&limit=25${projectParam}`
        : `/api/memory?limit=50${projectParam}`;
      setItems(await api<Memory[]>("GET", route));
    } catch (err) {
      setError((err as Error).message);
    }
  }, [query, projectFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<ProjectMap[]>("GET", "/api/projects").then((list) => setProjects(list.map((p) => p.name))).catch(() => {});
  }, []);

  const projectOptions = useMemo(() => {
    const set = new Set<string>(projects);
    for (const it of items) if (it.project) set.add(it.project);
    return Array.from(set).sort();
  }, [projects, items]);

  const openRow = (mem: Memory) => {
    setSelected(mem);
    setShowNew(false);
    setDraft({ title: mem.title, body: mem.body, type: mem.type, project: mem.project ?? "", tags: (mem.tags ?? []).join(", ") });
  };

  const columns: Column<Memory>[] = [
    { key: "type", header: t("memories.colType"), width: "100px", render: (m) => <Tag variant={MEMORY_TYPE_TAG_VARIANT[m.type] ?? "default"}>{m.type}</Tag> },
    { key: "title", header: t("memories.colTitle"), render: (m) => m.title },
    { key: "project", header: t("memories.colProject"), width: "120px", render: (m) => m.project ?? "—" },
    { key: "updated", header: t("memories.colUpdated"), width: "150px", render: (m) => m.updated_at },
    {
      key: "actions",
      header: "",
      width: "130px",
      render: (m) => (
        <HStack gap={1}>
          <Button label={t("common.open")} variant="ghost" size="sm" onClick={() => openRow(m)} />
          <Button label={t("common.delete")} variant="ghost" size="sm" onClick={() => setDeleteTarget(m)} />
        </HStack>
      ),
    },
  ];

  const save = async () => {
    setSaving(true);
    try {
      const tags = draft.tags.split(",").map((s) => s.trim()).filter(Boolean);
      if (selected) {
        await api("PATCH", `/api/memory/${selected.id}`, { title: draft.title, body: draft.body, type: draft.type, project: draft.project || undefined, tags });
      } else {
        await api("POST", "/api/memory", { title: draft.title, body: draft.body, type: draft.type, project: draft.project || undefined, tags, source: "web-ui" });
      }
      toast({ body: t("common.savedToast"), type: "info" });
      setSelected(null);
      setShowNew(false);
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
      await api("DELETE", `/api/memory/${deleteTarget.id}`);
      toast({ body: t("common.deletedToast"), type: "info" });
      if (selected?.id === deleteTarget.id) {
        setSelected(null);
        setShowNew(false);
      }
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast({ body: `${t("common.deleteFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setDeleting(false);
    }
  };

  const editing = selected !== null || showNew;

  return (
    <VStack gap={4}>
      <HStack hAlign="between" vAlign="center">
        <Heading level={3}>{t("memories.title")}</Heading>
        <Button
          label={t("memories.newRecord")}
          variant="primary"
          onClick={() => {
            setSelected(null);
            setDraft({ title: "", body: "", type: "fact", project: "", tags: "" });
            setShowNew(true);
          }}
        />
      </HStack>
      <HStack gap={2} vAlign="end">
        <TextField label={t("common.search")} hideLabel placeholder={t("memories.searchPlaceholder")} value={query} onChange={setQuery} hasClear />
        <Select label={t("common.project")} hideLabel value={projectFilter} onChange={setProjectFilter} options={projectOptions.map((p) => ({ value: p, label: p }))} placeholder={t("common.all")} />
        <Button label={t("common.search")} variant="secondary" onClick={load} />
      </HStack>
      {error && <Text color="secondary">{t("common.error")}: {error}</Text>}
      {editing && (
        <Panel>
          <VStack gap={3}>
            <Heading level={4}>{selected ? `#${selected.id} ${t("memories.editTitle")}` : t("memories.newTitle")}</Heading>
            <TextField label={t("common.title")} value={draft.title} onChange={(v) => setDraft({ ...draft, title: v })} />
            <HStack gap={3}>
              <Select label={t("memories.type")} value={draft.type} onChange={(v) => setDraft({ ...draft, type: v })} options={MEMORY_TYPES.map((v) => ({ value: v, label: v }))} />
              <TextField label={t("common.project")} value={draft.project} onChange={(v) => setDraft({ ...draft, project: v })} optional />
            </HStack>
            <TextField label={t("memories.tags")} value={draft.tags} onChange={(v) => setDraft({ ...draft, tags: v })} optional />
            <TextArea label={t("memories.body")} value={draft.body} onChange={(v) => setDraft({ ...draft, body: v })} rows={6} />
            <HStack gap={2}>
              <Button label={saving ? t("common.saving") : t("common.save")} variant="primary" onClick={save} disabled={saving || !draft.title.trim() || !draft.body.trim()} />
              <Button label={t("common.cancel")} variant="secondary" onClick={() => { setSelected(null); setShowNew(false); }} />
              {selected && <Button label={t("common.delete")} variant="destructive" onClick={() => setDeleteTarget(selected)} />}
            </HStack>
          </VStack>
        </Panel>
      )}
      {items.length === 0 && !editing ? (
        <EmptyState title={query ? t("memories.emptyTitleQuery") : t("memories.emptyTitle")} description={query ? t("memories.emptyDescQuery") : t("memories.emptyDesc")} />
      ) : (
        <DataTable data={items} columns={columns} rowKey={(m) => String(m.id)} />
      )}

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("common.confirmDeleteTitle")}
        description={`"${deleteTarget?.title}" ${t("memories.confirmDeleteDesc")}`}
        actionLabel={t("memories.deleteAction")}
        cancelLabel={t("common.cancel")}
        loading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
}
