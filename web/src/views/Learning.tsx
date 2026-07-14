import { useCallback, useEffect, useState } from "react";
import { VStack, HStack, Grid } from "../components/ui/Stack";
import { Panel } from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { TextField } from "../components/ui/Field";
import { Heading, Text } from "../components/ui/Typography";
import { StatusDot } from "../components/ui/Tag";
import { Divider } from "../components/ui/Divider";
import { EmptyState } from "../components/ui/EmptyState";
import { Dialog } from "../components/ui/Dialog";
import { PixelMeter } from "../components/ui/PixelMeter";
import { useToast } from "../components/ui/useToast";
import { api, type RagDocument, type RagDocumentDetail, type RagSearchResult } from "../api";
import { useI18n } from "../i18n";
import { Markdown } from "../components/Markdown";

const LEARNING_PROJECT = "learning";

export function Learning() {
  const { t } = useI18n();
  const toast = useToast();
  const [docs, setDocs] = useState<RagDocument[] | null>(null);
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<RagSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [detail, setDetail] = useState<RagDocumentDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      setError("");
      const list = await api<RagDocument[]>("GET", `/api/rag/documents?project=${encodeURIComponent(LEARNING_PROJECT)}`);
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
      setDetail(await api<RagDocumentDetail>("GET", `/api/rag/documents/${doc.id}`));
    } catch (err) {
      toast({ body: `${t("common.loadFailed")}: ${(err as Error).message}`, type: "error" });
    } finally {
      setDetailLoading(false);
    }
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    setSearching(true);
    try {
      setSearchResults(await api<RagSearchResult[]>("GET", `/api/rag/search?q=${encodeURIComponent(searchQuery)}&project=${encodeURIComponent(LEARNING_PROJECT)}&limit=10`));
    } catch (err) {
      toast({ body: `${t("common.error")}: ${(err as Error).message}`, type: "error" });
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  const clearSearch = () => {
    setSearchQuery("");
    setSearchResults(null);
  };

  return (
    <VStack gap={5}>
      <HStack hAlign="between" vAlign="center">
        <VStack gap={1}>
          <Heading level={3}>{t("learning.title")}</Heading>
          <Text type="supporting" color="secondary">{t("learning.subtitle")}</Text>
        </VStack>
        <Button label={t("common.refresh")} variant="secondary" onClick={load} />
      </HStack>

      <HStack gap={2} vAlign="end">
        <TextField
          label={t("common.search")}
          hideLabel
          placeholder={t("learning.searchPlaceholder")}
          value={searchQuery}
          onChange={(v) => { setSearchQuery(v); if (!v.trim()) setSearchResults(null); }}
          hasClear
        />
        <Button label={searching ? t("common.searching") : t("common.search")} variant="secondary" onClick={runSearch} disabled={searching || !searchQuery.trim()} />
      </HStack>

      {error && <Text color="secondary">{t("common.error")}: {error}</Text>}

      {searchResults !== null ? (
        <VStack gap={3}>
          <HStack hAlign="between" vAlign="center">
            <Heading level={4}>{t("learning.searchResultsTitle")}</Heading>
            <Button label={t("learning.backToList")} variant="ghost" size="sm" onClick={clearSearch} />
          </HStack>
          {searchResults.length === 0 ? (
            <Text type="supporting" color="secondary">{t("learning.noResults")}</Text>
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
          )}
        </VStack>
      ) : docs === null ? (
        <Text color="secondary">{t("common.loading")}</Text>
      ) : docs.length === 0 ? (
        <EmptyState title={t("learning.empty")} description={t("learning.emptyDesc")} />
      ) : (
        <Grid minWidth={240} gap={4}>
          {docs.map((d) => (
            <Panel key={d.id} className="clickable" style={{ cursor: "pointer" }}>
              <div onClick={() => openDetail(d)}>
                <VStack gap={2}>
                  <HStack hAlign="between" vAlign="start">
                    <Heading level={4}>{d.title}</Heading>
                    <StatusDot variant={d.enabled ? "success" : "warning"} label={d.enabled ? t("rag.docActive") : t("rag.docDisabled")} />
                  </HStack>
                  <Text type="supporting" color="secondary">{d.created_at} · {d.chunk_count} {t("learning.chunkCount")}</Text>
                  {d.chunk_count > 0 && <PixelMeter value={d.vec_count} max={d.chunk_count} blocks={16} variant="success" />}
                </VStack>
              </div>
            </Panel>
          ))}
        </Grid>
      )}

      <Dialog isOpen={detail !== null || detailLoading} onOpenChange={(open) => { if (!open) setDetail(null); }} width={640} title={detail?.title ?? t("common.loading")}>
        {detailLoading ? (
          <Text color="secondary">{t("common.loading")}</Text>
        ) : detail ? (
          <VStack gap={3}>
            <Text type="supporting" color="secondary">
              {detail.uri ?? t("rag.uriMissing")} · {detail.project ?? t("rag.projectMissing")} · {detail.chunk_count} {t("learning.chunkCount")}
            </Text>
            <Divider />
            {detail.chunks.length === 0 ? (
              <Text type="supporting" color="secondary">{t("learning.noChunks")}</Text>
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
        ) : null}
      </Dialog>
    </VStack>
  );
}
