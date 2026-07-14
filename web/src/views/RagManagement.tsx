import { useCallback, useEffect, useMemo, useState } from "react";
import { VStack, HStack } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button, IconButton } from "../components/ui/Button";
import { TextField, TextArea, Switch, Select } from "../components/ui/Field";
import { Heading, Text } from "../components/ui/Typography";
import { EmptyState } from "../components/ui/EmptyState";
import { AlertDialog, Dialog } from "../components/ui/Dialog";
import { Divider } from "../components/ui/Divider";
import { Tag } from "../components/ui/Tag";
import { DataTable, type Column } from "../components/ui/DataTable";
import { Icon } from "../components/icons/Icons";
import { useToast } from "../components/ui/useToast";
import { Ticker } from "../components/ui/Ticker";
import { api, type ProjectMap, type RagDocument, type RagDocumentDetail, type RagSearchResult, type ReindexResult } from "../api";
import { useI18n } from "../i18n";
import { Markdown } from "../components/Markdown";

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
    api<ProjectMap[]>("GET", "/api/projects").then((list) => setProjects(list.map((p) => p.name))).catch(() => {});
  }, []);

  const projectOptions = useMemo(() => {
    const set = new Set<string>(projects);
    for (const d of docs ?? []) if (d.project) set.add(d.project);
    return Array.from(set).sort();
  }, [projects, docs]);

  const openDetail = async (doc: RagDocument) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await api<RagDocumentDetail>("GET", `/api/rag/documents/${doc.id}`));
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
      setSearchResults(await api<RagSearchResult[]>("GET", `/api/rag/search?q=${encodeURIComponent(searchQuery)}&limit=10`));
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
      await api("POST", "/api/rag/documents", { title: newTitle.trim(), text: newText, uri: newUri.trim() || undefined, project: newProject.trim() || undefined });
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

  const columns: Column<RagDocument>[] = [
    {
      key: "enabled",
      header: "",
      width: "56px",
      render: (d) => <Switch checked={d.enabled} onChange={(v) => toggleEnabled(d, v)} label={d.enabled ? t("rag.docActive") : t("rag.docDisabled")} />,
    },
    {
      key: "title",
      header: t("rag.docTitle"),
      render: (d) => (
        <VStack gap={0}>
          <Text style={d.enabled ? undefined : { opacity: 0.5 }}>{d.title}</Text>
          {d.uri && <Text type="supporting" color="secondary" style={{ opacity: d.enabled ? 1 : 0.5 }}>{d.uri}</Text>}
        </VStack>
      ),
    },
    { key: "project", header: t("common.project"), width: "130px", render: (d) => d.project ?? "—" },
    {
      key: "chunks",
      header: t("rag.colChunk"),
      width: "100px",
      render: (d) => <Tag variant={d.vec_count === d.chunk_count && d.chunk_count > 0 ? "accent" : "warn"}>{d.vec_count}/{d.chunk_count}</Tag>,
    },
    { key: "created", header: t("rag.colCreated"), width: "140px", render: (d) => d.created_at },
    {
      key: "actions",
      header: "",
      width: "100px",
      render: (d) => (
        <HStack gap={1}>
          <Button label={t("common.open")} variant="ghost" size="sm" onClick={() => openDetail(d)} />
          <IconButton label={t("rag.deleteDoc")} icon={<Icon name="trash" size={14} />} onClick={() => setDeleteTarget(d)} size="sm" />
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
        <HStack gap={6}>
          <VStack gap={0}>
            <span className="u-label">{t("common.title")}</span>
            <Ticker value={docs?.length ?? 0} size="sm" />
          </VStack>
          <VStack gap={0}>
            <span className="u-label">{t("rag.colChunk")}</span>
            <Ticker value={totalChunks} size="sm" />
          </VStack>
        </HStack>
        <HStack gap={2} wrap="wrap" vAlign="end">
          <Select
            label={t("common.project")}
            hideLabel
            value={projectFilter}
            onChange={setProjectFilter}
            options={projectOptions.map((p) => ({ value: p, label: p }))}
            placeholder={t("common.all")}
          />
          <Button label={t("common.refresh")} variant="secondary" onClick={load} />
          <Button label={reindexing ? t("rag.reindexing") : t("rag.reindexDone")} variant="secondary" icon={<Icon name="refresh" size={13} />} disabled={reindexing} onClick={() => runReindex(false)} />
          <Button label={t("rag.forceReindex")} variant="primary" disabled={reindexing} onClick={() => setReindexConfirm(true)} />
        </HStack>
      </VStack>

      {reindexResult && (
        <Panel variant={reindexResult.ok ? "default" : "danger"}>
          <Text color="secondary">
            {reindexResult.ok
              ? `${reindexResult.chunks_embedded} chunk, ${reindexResult.memories_embedded} ${t("common.title").toLowerCase()}`
              : `${t("common.error")}: ${reindexResult.error ?? "?"}`}
          </Text>
        </Panel>
      )}

      <Panel>
        <VStack gap={3}>
          <Heading level={4}>{t("rag.searchTestTitle")}</Heading>
          <Text type="supporting" color="secondary">{t("rag.searchTestDesc")}</Text>
          <HStack gap={2} vAlign="end">
            <TextField label={t("common.search")} hideLabel placeholder={t("rag.searchPlaceholder")} value={searchQuery} onChange={setSearchQuery} hasClear />
            <Button label={searching ? t("common.searching") : t("common.search")} variant="secondary" onClick={runSearch} disabled={searching || !searchQuery.trim()} />
          </HStack>
          {searchResults !== null &&
            (searchResults.length === 0 ? (
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
            ))}
        </VStack>
      </Panel>

      {error && (
        <Panel variant="danger">
          <Text color="secondary">{t("common.error")}: {error}</Text>
        </Panel>
      )}

      {detail && (
        <Panel>
          <VStack gap={3}>
            <HStack hAlign="between" vAlign="center">
              <Heading level={4}>{detail.title}</Heading>
              <Button label={t("common.close")} variant="ghost" size="sm" onClick={() => setDetail(null)} />
            </HStack>
            <Text type="supporting" color="secondary">{detail.uri ?? t("rag.uriMissing")} · {detail.project ?? t("rag.projectMissing")} · {detail.chunk_count} chunk</Text>
            <Divider />
            {detail.chunks.length === 0 ? (
              <Text type="supporting" color="secondary">{t("rag.noChunks")}</Text>
            ) : (
              <VStack gap={3}>
                {detail.chunks.map((c) => (
                  <VStack key={c.id} gap={1}>
                    <Text type="supporting" color="secondary">Chunk #{c.seq}{c.heading ? ` — ${c.heading}` : ""}</Text>
                    <Markdown>{c.text}</Markdown>
                  </VStack>
                ))}
              </VStack>
            )}
          </VStack>
        </Panel>
      )}
      {detailLoading && <Text color="secondary">{t("common.loading")}</Text>}

      {docs === null ? (
        <Text color="secondary">{t("common.loading")}</Text>
      ) : docs.length === 0 ? (
        <EmptyState title={t("rag.empty")} description={t("rag.emptyDesc")} />
      ) : (
        <DataTable data={docs} columns={columns} rowKey={(d) => String(d.id)} />
      )}

      <Dialog isOpen={showNew} onOpenChange={setShowNew} width={560} title={t("rag.addDialogTitle")}>
        <TextField label={t("rag.docTitle")} value={newTitle} onChange={setNewTitle} />
        <HStack gap={3}>
          <TextField label={t("rag.docUri")} value={newUri} onChange={setNewUri} optional />
          <TextField label={t("common.project")} value={newProject} onChange={setNewProject} optional />
        </HStack>
        <TextArea label={t("rag.docText")} value={newText} onChange={setNewText} rows={10} />
        <HStack gap={2}>
          <Button label={creating ? t("common.saving") : t("common.create")} variant="primary" onClick={createDocument} disabled={creating || !newTitle.trim() || !newText.trim()} />
          <Button label={t("common.cancel")} variant="secondary" onClick={() => setShowNew(false)} />
        </HStack>
      </Dialog>

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title={t("rag.docDeletedConfirm")}
        description={`"${deleteTarget?.title}" ${t("rag.docDeleteDesc")}`}
        actionLabel={t("rag.deleteDoc")}
        cancelLabel={t("common.cancel")}
        loading={deleting}
        onAction={confirmDelete}
      />

      <AlertDialog
        isOpen={reindexConfirm}
        onOpenChange={setReindexConfirm}
        title={t("rag.forceReindexConfirmTitle")}
        description={t("rag.forceReindexConfirmDesc")}
        actionLabel={t("rag.forceReindex")}
        cancelLabel={t("common.cancel")}
        onAction={() => runReindex(true)}
      />
    </VStack>
  );
}
