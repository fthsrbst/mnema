import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Card } from "@astryxdesign/core/Card";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Switch } from "@astryxdesign/core/Switch";
import { Table, pixel, proportional, type TableColumn } from "@astryxdesign/core/Table";
import { Text, Heading } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Divider } from "@astryxdesign/core/Divider";
import { useToast } from "@astryxdesign/core/Toast";
import { TrashIcon, ArrowPathIcon } from "@heroicons/react/24/outline";
import {
  api,
  type RagDocument,
  type RagDocumentDetail,
  type RagSearchResult,
  type ReindexResult,
} from "../api";

interface Row extends Record<string, unknown> {
  id: string;
  doc: RagDocument;
}

export function RagManagement() {
  const toast = useToast();
  const [docs, setDocs] = useState<RagDocument[] | null>(null);
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

  const load = useCallback(async () => {
    try {
      setError("");
      const list = await api<RagDocument[]>("GET", "/api/rag/documents");
      setDocs(list.map((d) => ({ ...d, enabled: Boolean(d.enabled) })));
    } catch (err) {
      setError((err as Error).message);
      setDocs([]);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = async (doc: RagDocument) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      const full = await api<RagDocumentDetail>("GET", `/api/rag/documents/${doc.id}`);
      setDetail(full);
    } catch (err) {
      toast({ body: `Doküman yüklenemedi: ${(err as Error).message}`, type: "error" });
    } finally {
      setDetailLoading(false);
    }
  };

  const toggleEnabled = async (doc: RagDocument, enabled: boolean) => {
    try {
      await api("PATCH", `/api/rag/documents/${doc.id}`, { enabled });
      setDocs((prev) => prev?.map((d) => (d.id === doc.id ? { ...d, enabled } : d)) ?? null);
      toast({ body: enabled ? `"${doc.title}" açıldı` : `"${doc.title}" kapatıldı`, type: "info", uniqueID: `toggle-${doc.id}` });
    } catch (err) {
      toast({ body: `İşlem başarısız: ${(err as Error).message}`, type: "error" });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api("DELETE", `/api/rag/documents/${deleteTarget.id}`);
      toast({ body: `"${deleteTarget.title}" silindi`, type: "info" });
      setDeleteTarget(null);
      if (detail?.id === deleteTarget.id) setDetail(null);
      await load();
    } catch (err) {
      toast({ body: `Silme başarısız: ${(err as Error).message}`, type: "error" });
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
          ? `Yeniden indeksleme tamam: ${result.chunks_embedded} chunk, ${result.memories_embedded} hafıza`
          : `Yeniden indeksleme hata verdi: ${result.error ?? "bilinmiyor"}`,
        type: result.ok ? "info" : "error",
      });
      await load();
    } catch (err) {
      toast({ body: `Yeniden indeksleme başarısız: ${(err as Error).message}`, type: "error" });
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
      toast({ body: `Arama başarısız: ${(err as Error).message}`, type: "error" });
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const columns: TableColumn<Row>[] = [
    {
      key: "enabled",
      header: "",
      width: pixel(60),
      renderCell: (r: Row) => (
        <Switch
          label={r.doc.enabled ? "Aktif" : "Kapalı"}
          isLabelHidden
          value={r.doc.enabled}
          changeAction={(checked) => toggleEnabled(r.doc, checked)}
        />
      ),
    },
    {
      key: "title",
      header: "Başlık",
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
    { key: "project", header: "Proje", width: pixel(130), renderCell: (r: Row) => r.doc.project ?? "—" },
    {
      key: "chunks",
      header: "Chunk",
      width: pixel(110),
      renderCell: (r: Row) => (
        <Badge
          variant={r.doc.vec_count === r.doc.chunk_count && r.doc.chunk_count > 0 ? "neutral" : "warning"}
          label={`${r.doc.vec_count}/${r.doc.chunk_count}`}
        />
      ),
    },
    { key: "created", header: "Eklenme", width: pixel(140), renderCell: (r: Row) => r.doc.created_at },
    {
      key: "actions",
      header: "",
      width: pixel(110),
      renderCell: (r: Row) => (
        <HStack gap={1}>
          <Button label="Aç" variant="ghost" size="sm" onClick={() => openDetail(r.doc)} />
          <IconButton
            label="Dokümanı sil"
            tooltip="Sil"
            variant="ghost"
            size="sm"
            icon={<TrashIcon width={16} height={16} />}
            onClick={() => setDeleteTarget(r.doc)}
          />
        </HStack>
      ),
    },
  ];

  return (
    <VStack gap={5}>
      <VStack gap={3}>
        <VStack gap={1}>
          <Heading level={3}>RAG Yönetimi</Heading>
          <Text type="supporting" color="secondary">Doküman kaynakları, embedding durumu ve arama testleri</Text>
        </VStack>
        <HStack gap={2} wrap="wrap">
          <Button label="Yenile" variant="secondary" onClick={load} />
          <Button
            label={reindexing ? "İndeksleniyor..." : "Eksikleri tamamla"}
            variant="secondary"
            icon={<ArrowPathIcon width={16} height={16} />}
            isDisabled={reindexing}
            onClick={() => runReindex(false)}
          />
          <Button
            label="Zorla yeniden indeksle"
            variant="primary"
            isDisabled={reindexing}
            onClick={() => setReindexConfirm(true)}
          />
        </HStack>
      </VStack>

      {reindexResult && (
        <Card variant={reindexResult.ok ? "green" : "red"}>
          <Text color="secondary">
            {reindexResult.ok
              ? `Son çalıştırma: ${reindexResult.chunks_embedded} chunk ve ${reindexResult.memories_embedded} hafıza embedding'e kavuştu.`
              : `Son çalıştırma hata verdi: ${reindexResult.error ?? "bilinmiyor"}`}
          </Text>
        </Card>
      )}

      <Card>
        <VStack gap={3}>
          <Heading level={4}>Arama testi</Heading>
          <Text type="supporting" color="secondary">Agent'ın hibrit aramada göreceği sonucu burada canlı dene.</Text>
          <HStack gap={2} vAlign="end">
            <TextInput
              label="Sorgu"
              isLabelHidden
              placeholder="Örn: sqlite-vec kurulumu..."
              value={searchQuery}
              onChange={setSearchQuery}
              hasClear
            />
            <Button label={searching ? "Aranıyor..." : "Ara"} variant="secondary" onClick={runSearch} isDisabled={searching || !searchQuery.trim()} />
          </HStack>
          {searchResults !== null && (
            searchResults.length === 0 ? (
              <Text type="supporting" color="secondary">Sonuç bulunamadı.</Text>
            ) : (
              <VStack gap={2}>
                {searchResults.map((r) => (
                  <VStack key={r.chunk_id} gap={1}>
                    <HStack hAlign="between">
                      <Text type="supporting">{r.document_title}{r.heading ? ` — ${r.heading}` : ""}</Text>
                      {r.score !== undefined && <Text type="supporting" color="secondary">skor: {r.score.toFixed(3)}</Text>}
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
        <Card variant="red">
          <Text color="secondary">Hata: {error}</Text>
        </Card>
      )}

      {detail && (
        <Card>
          <VStack gap={3}>
            <HStack hAlign="between" vAlign="center">
              <Heading level={4}>{detail.title}</Heading>
              <Button label="Kapat" variant="ghost" size="sm" onClick={() => setDetail(null)} />
            </HStack>
            <Text type="supporting" color="secondary">
              {detail.uri ?? "URI yok"} · {detail.project ?? "proje yok"} · {detail.chunk_count} chunk
            </Text>
            <Divider />
            {detail.chunks.length === 0 ? (
              <Text type="supporting" color="secondary">Bu dokümanda henüz chunk yok.</Text>
            ) : (
              <VStack gap={3}>
                {detail.chunks.map((c) => (
                  <VStack key={c.id} gap={1}>
                    <Text type="supporting" color="secondary">
                      Chunk #{c.seq}{c.heading ? ` — ${c.heading}` : ""}
                    </Text>
                    <Text style={{ whiteSpace: "pre-wrap" }}>{c.text}</Text>
                  </VStack>
                ))}
              </VStack>
            )}
          </VStack>
        </Card>
      )}
      {detailLoading && <Text color="secondary">Doküman yükleniyor...</Text>}

      {docs === null ? (
        <Text color="secondary">Yükleniyor...</Text>
      ) : docs.length === 0 ? (
        <EmptyState title="Doküman yok" description="RAG'e agentlar rag_add ile ekler; buradan yönetebilirsin." />
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

      <AlertDialog
        isOpen={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Doküman silinsin mi?"
        description={`"${deleteTarget?.title}" ve tüm chunk'ları kalıcı olarak silinecek. Bu işlem geri alınamaz.`}
        actionLabel="Dokümanı sil"
        cancelLabel="Vazgeç"
        actionVariant="destructive"
        isActionLoading={deleting}
        onAction={confirmDelete}
      />

      <AlertDialog
        isOpen={reindexConfirm}
        onOpenChange={setReindexConfirm}
        title="Zorla yeniden indekslensin mi?"
        description="Tüm dokümanlar ve hafıza kayıtları sıfırdan yeniden embed edilecek. Doküman sayısına göre uzun sürebilir ve embedding API kotasını tüketebilir."
        actionLabel="Zorla yeniden indeksle"
        actionVariant="destructive"
        cancelLabel="Vazgeç"
        onAction={() => runReindex(true)}
      />
    </VStack>
  );
}
