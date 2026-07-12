import { useCallback, useEffect, useMemo, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Selector } from "@astryxdesign/core/Selector";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useToast } from "@astryxdesign/core/Toast";
import { api, type Memory, type ProjectMap } from "../api";
import { useI18n } from "../i18n";

interface Row extends Record<string, unknown> {
  id: string;
  mem: Memory;
}

const MEMORY_TYPES = ["fact", "preference", "decision", "howto", "context"];

// Sabit tag paleti eşlemesi — tüm görünümlerde aynı tutulmalı (bkz. Sessions/Projects/Learning).
const MEMORY_TYPE_TAG_CLASS: Record<string, string> = {
  decision: "rx-tag-navy",
  howto: "rx-tag-forest",
  preference: "rx-tag-amber",
  context: "rx-tag-blue",
  fact: "rx-tag-blue",
};

function memoryTypeTagClass(type: string): string {
  return MEMORY_TYPE_TAG_CLASS[type] ?? "rx-tag-blue";
}

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
    api<ProjectMap[]>("GET", "/api/projects")
      .then((list) => setProjects(list.map((p) => p.name)))
      .catch(() => {});
  }, []);

  // Dropdown seçenekleri: /api/projects listesi + yüklü kayıtlarda geçen proje adları birleşimi.
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

  const columns: TableColumn<Row>[] = [
    {
      key: "type",
      header: t("memories.colType"),
      width: pixel(100),
      renderCell: (r: Row) => <span className={`rx-tag ${memoryTypeTagClass(r.mem.type)}`}>{r.mem.type}</span>,
    },
    { key: "title", header: t("memories.colTitle"), width: proportional(1), renderCell: (r: Row) => r.mem.title },
    { key: "project", header: t("memories.colProject"), width: pixel(120), renderCell: (r: Row) => r.mem.project ?? "—" },
    { key: "updated", header: t("memories.colUpdated"), width: pixel(150), renderCell: (r: Row) => r.mem.updated_at },
    {
      key: "actions",
      header: "",
      width: pixel(140),
      renderCell: (r: Row) => (
        <HStack gap={1}>
          <Button label={t("common.open")} variant="ghost" size="sm" onClick={() => openRow(r.mem)} />
          <Button label={t("common.delete")} variant="ghost" size="sm" onClick={() => setDeleteTarget(r.mem)} />
        </HStack>
      ),
    },
  ];

  const save = async () => {
    setSaving(true);
    try {
      const tags = draft.tags.split(",").map((s) => s.trim()).filter(Boolean);
      if (selected) {
        await api("PATCH", `/api/memory/${selected.id}`, {
          title: draft.title,
          body: draft.body,
          type: draft.type,
          project: draft.project || undefined,
          tags,
        });
      } else {
        await api("POST", "/api/memory", {
          title: draft.title,
          body: draft.body,
          type: draft.type,
          project: draft.project || undefined,
          tags,
          source: "web-ui",
        });
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
        <TextInput
          className="rx-search"
          label={t("common.search")}
          isLabelHidden
          placeholder={t("memories.searchPlaceholder")}
          value={query}
          onChange={(v: string) => setQuery(v)}
          hasClear
        />
        <Selector
          label={t("common.project")}
          isLabelHidden
          value={projectFilter}
          onChange={setProjectFilter}
          options={[{ value: "", label: t("common.all") }, ...projectOptions.map((p) => ({ value: p, label: p }))]}
          placeholder={t("common.all")}
          width={180}
        />
        <Button label={t("common.search")} variant="secondary" onClick={load} />
      </HStack>
      {error && <Text color="secondary">{t("common.error")}: {error}</Text>}
      {editing && (
        <Card className="glass-card">
          <VStack gap={3}>
            <Heading level={4}>{selected ? `#${selected.id} ${t("memories.editTitle")}` : t("memories.newTitle")}</Heading>
            <TextInput label={t("common.title")} value={draft.title} onChange={(v: string) => setDraft({ ...draft, title: v })} isRequired />
            <HStack gap={3}>
              <Selector
                label={t("memories.type")}
                value={draft.type}
                onChange={(v) => setDraft({ ...draft, type: v })}
                options={MEMORY_TYPES}
              />
              <TextInput label={t("common.project")} value={draft.project} onChange={(v: string) => setDraft({ ...draft, project: v })} isOptional />
            </HStack>
            <TextInput label={t("memories.tags")} value={draft.tags} onChange={(v: string) => setDraft({ ...draft, tags: v })} isOptional />
            <TextArea label={t("memories.body")} value={draft.body} onChange={(v: string) => setDraft({ ...draft, body: v })} rows={6} isRequired />
            <HStack gap={2}>
              <Button label={saving ? t("common.saving") : t("common.save")} variant="primary" onClick={save} isDisabled={saving || !draft.title.trim() || !draft.body.trim()} />
              <Button label={t("common.cancel")} variant="secondary" onClick={() => { setSelected(null); setShowNew(false); }} />
              {selected && <Button label={t("common.delete")} variant="destructive" onClick={() => setDeleteTarget(selected)} />}
            </HStack>
          </VStack>
        </Card>
      )}
      {items.length === 0 && !editing ? (
        <EmptyState
          title={query ? t("memories.emptyTitleQuery") : t("memories.emptyTitle")}
          description={query ? t("memories.emptyDescQuery") : t("memories.emptyDesc")}
        />
      ) : (
        <Table<Row>
          data={items.map((m) => ({ id: String(m.id), mem: m }))}
          columns={columns}
          idKey="id"
          density="compact"
          dividers="rows"
          hasHover
        />
      )}

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("common.confirmDeleteTitle")}
        description={`"${deleteTarget?.title}" ${t("memories.confirmDeleteDesc")}`}
        actionLabel={t("memories.deleteAction")}
        cancelLabel={t("common.cancel")}
        actionVariant="destructive"
        isActionLoading={deleting}
        onAction={confirmDelete}
      />
    </VStack>
  );
}
