import { useCallback, useEffect, useMemo, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Switch } from "@astryxdesign/core/Switch";
import { Selector } from "@astryxdesign/core/Selector";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { useToast } from "@astryxdesign/core/Toast";
import { TrashIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  api,
  type ProjectMap,
  type RagDocument,
  type RagDocumentDetail,
  type RagSearchResult,
  type ReindexResult,
} from "../api";
import { useI18n } from "../i18n";
import { Markdown } from "../components/Markdown";

interface Row extends Record<string, unknown> {
  id: string;
  doc: RagDocument;
}

export function RagManagement() {
  const { t } = useI18n();
  const toast = useToast();
  const [docs, setDocs] = useState<RagDocument[] | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [projects, setProjects] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState<RagDocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RagDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reindexConfirm, setReindexConfirm] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<ReindexResult | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RagSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newText, setNewText] = useState("");
  const [newUri, setNewUri] = useState("");
  const [newProject, setNewProject] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      const route = projectFilter ? `/api/rag/documents?project=${encodeURIComponent(projectFilter)}` : "/api/rag/documents";
      const list = await api<RagDocument[]>("GET", route);
      setDocs(list.map((d) => ({ ...d, enabled: Boolean(d.enabled) })));
    } catch (err) {
      setError((err as Error).message);
      setDocs([]);
    }
  }, [projectFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    api<ProjectMap[]>("GET", "/api/projects")
      .then((list) => setProjects(list.map((p) => p.name)))
      .catch(() => {});
  }, []);

  // Dropdown seçenekleri: /api/projects listesi + yüklü dokümanlarda geçen proje adları birleşimi.
  const projectOptions = useMemo(() => {
    const set = new Set<string>(projects);
    for (const d of docs ?? []) if (d.project) set.add(d.project);
    return Array.from(set).sort();
  }, [projects, docs]);

  const openDetail = async (doc: RagDocument) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const full = await api<RagDocumentDetail>("GET", `/api/rag/documents/${doc.id}`);
      setDetail(full);
    } catch (err) {
      toast({ body: `${t("common.loadFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setDetailLoading(false);
    }
  };

  const toggleEnabled = async (doc: RagDocument, enabled: boolean) => {
    try {
      await api("PATCH", `/api/rag/documents/${doc.id}`, { enabled });
      setDocs((prev) => prev?.map((d) => (d.id === doc.id ? { ...d, enabled } : d)) ?? null);
      toast({ body: enabled ? `"${doc.title}" ${t("rag.docActive").toLowerCase()}` : `"${doc.title}" ${t("rag.docDisabled").toLowerCase()}`, type: "info", uniqueID: `toggle-${doc.id}` });
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api("DELETE", `/api/rag/documents/${deleteTarget.id}`);
      toast({ body: t("common.deletedToast"), type: "info" });
      setDeleteTarget(null);
      if (detail?.id === deleteTarget.id) setDetail(null);
      await load();
    } catch (err) {
      toast({ body: `${t("common.deleteFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setDeleting(false);
    }
  };

  const runReindex = async (force: boolean) => {
    setReindexConfirm(false);
    setReindexing(true);
    setReindexResult(null);
    try {
      const result = await api<ReindexResult>("POST", "/api/rag/reindex", { force });
      setReindexResult(result);
      toast({
        body: result.ok
          ? `${t("common.savedToast")}: ${result.chunks_embedded} chunk, ${result.memories_embedded} ${t("common.title").toLowerCase()}`
          : `${t("common.saveFailed")}: ${result.error ?? "?"}`,
        type: result.ok ? "info" : "error",
      });
      await load();
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setReindexing(false);
    }
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      const results = await api<RagSearchResult[]>("GET", `/api/rag/search?q=${encodeURIComponent(searchQuery)}&limit=10`);
      setSearchResults(results);
    } catch (err) {
      toast({ body: `${t("common.error")}: ${(err as Error).message}`, type: "error" });
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const createDocument = async () => {
    if (!newTitle.trim() || !newText.trim()) return;
    setCreating(true);
    try {
      await api("POST", "/api/rag/documents", {
        title: newTitle.trim(),
        text: newText,
        uri: newUri.trim() || undefined,
        project: newProject.trim() || undefined,
      });
      toast({ body: t("common.createdToast"), type: "info" });
      setShowNew(false);
      setNewTitle("");
      setNewText("");
      setNewUri("");
      setNewProject("");
      await load();
    } catch (err) {
      toast({ body: `${t("common.saveFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setCreating(false);
    }
  };

  const columns: TableColumn<Row>[] = [
    {
      key: "enabled",
      header: "",
      width: pixel(60),
      renderCell: (r: Row) => (
        <Switch
          label={r.doc.enabled ? t("rag.docActive") : t("rag.docDisabled")}
          isLabelHidden
          value={r.doc.enabled}
          changeAction={(checked) => toggleEnabled(r.doc, checked)}
        />
      ),
    },
    {
      key: "title",
      header: t("rag.docTitle"),
      width: proportional(2),
      renderCell: (r: Row) => (
        <VStack gap={0}>
          <Text style={r.doc.enabled ? undefined : { opacity: 0.5 }}>{r.doc.title}</Text>
          {r.doc.uri && (
            <Text type="supporting" color="secondary" style={{ opacity: r.doc.enabled ? 1 : 0.5 }}>
              {r.doc.uri}
            </Text>
          )}
        </VStack>
      ),
    },
    { key: "project", header: t("common.project"), width: pixel(130), renderCell: (r: Row) => r.doc.project ?? "—" },
    {
      key: "chunks",
      header: t("rag.colChunk"),
      width: pixel(110),
      renderCell: (r: Row) => (
        <span className={`rx-tag ${r.doc.vec_count === r.doc.chunk_count && r.doc.chunk_count > 0 ? "rx-tag-forest" : "rx-tag-amber"}`}>
          {r.doc.vec_count}/{r.doc.chunk_count}
        </span>
      ),
    },
    { key: "created", header: t("rag.colCreated"), width: pixel(140), renderCell: (r: Row) => r.doc.created_at },
    {
      key: "actions",
      header: "",
      width: pixel(110),
      renderCell: (r: Row) => (
        <HStack gap={1}>
          <Button label={t("common.open")} variant="ghost" size="sm" onClick={() => openDetail(r.doc)} />
          <IconButton
            label={t("rag.deleteDoc")}
            tooltip={t("common.delete")}
            variant="ghost"
            size="sm"
            icon={<TrashIcon width={16} height={16} />}
            onClick={() => setDeleteTarget(r.doc)}
          />
        </HStack>
      ),
    },
  ];

  const totalChunks = (docs ?? []).reduce((sum, d) => sum + (d.chunk_count ?? 0), 0);

  return (
    <VStack gap={5}>
      <VStack gap={3}>
        <HStack hAlign="between" vAlign="start">
          <VStack gap={1}>
            <Heading level={3}>{t("rag.title")}</Heading>
            <Text type="supporting" color="secondary">{t("rag.subtitle")}</Text>
          </VStack>
          <Button label={t("rag.addDocument")} variant="primary" onClick={() => { setNewTitle(""); setNewText(""); setNewUri(""); setNewProject(""); setShowNew(true); }} />
        </HStack>
        <HStack gap={5}>
          <VStack gap={0}>
            <span className="rx-label">{t("common.title")}</span>
            <span className="rx-display-sm">{docs?.length ?? "—"}</span>
          </VStack>
          <VStack gap={0}>
            <span className="rx-label">{t("rag.colChunk")}</span>
            <span className="rx-display-sm">{totalChunks}</span>
          </VStack>
        </HStack>
        <HStack gap={2} wrap="wrap" vAlign="end">
          <Selector
            label={t("common.project")}
            isLabelHidden
            value={projectFilter}
            onChange={setProjectFilter}
            options={[{ value: "", label: t("common.all") }, ...projectOptions.map((p) => ({ value: p, label: p }))]}
            placeholder={t("common.all")}
            width={180}
          />
          <Button label={t("common.refresh")} variant="secondary" onClick={load} />
          <Button
            label={reindexing ? t("rag.reindexing") : t("rag.reindexDone")}
            variant="secondary"
            icon={<ArrowPathIcon width={16} height={16} />}
            isDisabled={reindexing}
            onClick={() => runReindex(false)}
          />
          <Button
            label={t("rag.forceReindex")}
            variant="primary"
            isDisabled={reindexing}
            onClick={() => setReindexConfirm(true)}
          />
        </HStack>
      </VStack>

      {reindexResult && (
        <Card variant={reindexResult.ok ? "green" : "red"} className="glass-card">
          <Text color="secondary">
            {reindexResult.ok
              ? `${reindexResult.chunks_embedded} chunk, ${reindexResult.memories_embedded} ${t("common.title").toLowerCase()}`
              : `${t("common.error")}: ${reindexResult.error ?? "?"}`}
          </Text>
        </Card>
      )}

      <Card className="glass-card">
        <VStack gap={3}>
          <Heading level={4}>{t("rag.searchTestTitle")}</Heading>
          <Text type="supporting" color="secondary">{t("rag.searchTestDesc")}</Text>
          <HStack gap={2} vAlign="end">
            <TextInput
              className="rx-search"
              label={t("common.search")}
              isLabelHidden
              placeholder={t("rag.searchPlaceholder")}
              value={searchQuery}
              onChange={setSearchQuery}
              hasClear
            />
            <Button label={searching ? t("common.searching") : t("common.search")} variant="secondary" onClick={runSearch} isDisabled={searching || !searchQuery.trim()} />
          </HStack>
          {searchResults !== null && (
            searchResults.length === 0 ? (
              <Text type="supporting" color="secondary">{t("rag.noResults")}</Text>
            ) : (
              <VStack gap={2}>
                {searchResults.map((r) => (
                  <VStack key={r.chunk_id} gap={1}>
                    <HStack hAlign="between">
                      <Text type="supporting">{r.document_title}{r.heading ? ` — ${r.heading}` : ""}</Text>
                      {r.score !== undefined && <Text type="supporting" color="secondary">{t("rag.score")}: {r.score.toFixed(3)}</Text>}
                    </HStack>
                    <Text type="supporting" color="secondary">{r.text.slice(0, 220)}{r.text.length > 220 ? "…" : ""}</Text>
                    <Divider />
                  </VStack>
                ))}
              </VStack>
            )
          )}
        </VStack>
      </Card>

      {error && (
        <Card variant="red" className="glass-card">
          <Text color="secondary">{t("common.error")}: {error}</Text>
        </Card>
      )}

      {detail && (
        <Card className="glass-card">
          <VStack gap={3}>
            <HStack hAlign="between" vAlign="center">
              <Heading level={4}>{detail.title}</Heading>
              <Button label={t("common.close")} variant="ghost" size="sm" onClick={() => setDetail(null)} />
            </HStack>
            <Text type="supporting" color="secondary">
              {detail.uri ?? t("rag.uriMissing")} · {detail.project ?? t("rag.projectMissing")} · {detail.chunk_count} chunk
            </Text>
            <Divider />
            {detail.chunks.length === 0 ? (
              <Text type="supporting" color="secondary">{t("rag.noChunks")}</Text>
            ) : (
              <VStack gap={3}>
                {detail.chunks.map((c) => (
                  <VStack key={c.id} gap={1}>
                    <Text type="supporting" color="secondary">
                      Chunk #{c.seq}{c.heading ? ` — ${c.heading}` : ""}
                    </Text>
                    <Markdown>{c.text}</Markdown>
                  </VStack>
                ))}
              </VStack>
            )}
          </VStack>
        </Card>
      )}
      {detailLoading && <Text color="secondary">{t("common.loading")}</Text>}

      {docs === null ? (
        <Text color="secondary">{t("common.loading")}</Text>
      ) : docs.length === 0 ? (
        <EmptyState title={t("rag.empty")} description={t("rag.emptyDesc")} />
      ) : (
        <Table<Row>
          data={docs.map((d) => ({ id: String(d.id), doc: d }))}
          columns={columns}
          idKey="id"
          density="compact"
          dividers="rows"
          hasHover
        />
      )}

      <Dialog isOpen={showNew} onOpenChange={setShowNew} purpose="form" width={560}>
        <DialogHeader title={t("rag.addDialogTitle")} />
        <VStack gap={3} paddingInline={5} paddingBlock={4}>
          <TextInput label={t("rag.docTitle")} value={newTitle} onChange={setNewTitle} isRequired />
          <HStack gap={3}>
            <TextInput label={t("rag.docUri")} value={newUri} onChange={setNewUri} isOptional />
            <TextInput label={t("common.project")} value={newProject} onChange={setNewProject} isOptional />
          </HStack>
          <TextArea label={t("rag.docText")} value={newText} onChange={setNewText} rows={10} isRequired />
          <HStack gap={2}>
            <Button label={creating ? t("common.saving") : t("common.create")} variant="primary" onClick={createDocument} isDisabled={creating || !newTitle.trim() || !newText.trim()} />
            <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowNew(false)} />
          </HStack>
        </VStack>
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("rag.docDeletedConfirm")}
        description={`"${deleteTarget?.title}" ${t("rag.docDeleteDesc")}`}
        actionLabel={t("rag.deleteDoc")}
        cancelLabel={t("common.cancel")}
        actionVariant="destructive"
        isActionLoading={deleting}
        onAction={confirmDelete}
      />

      <AlertDialog
        isOpen={reindexConfirm}
        onOpenChange={setReindexConfirm}
        title={t("rag.forceReindexConfirmTitle")}
        description={t("rag.forceReindexConfirmDesc")}
        actionLabel={t("rag.forceReindex")}
        actionVariant="destructive"
        cancelLabel={t("common.cancel")}
        onAction={() => runReindex(true)}
      />
    </VStack>
  );
}
