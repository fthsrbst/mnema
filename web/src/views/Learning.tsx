import { useCallback, useEffect, useState } from "react";
import { VStack, HStack } from "@astryxdesign/core/Layout";
import { Grid } from "@astryxdesign/core/Grid";
import { Card } from "@astryxdesign/core/Card";
import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Button } from "@astryxdesign/core/Button";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Text, Heading } from "@astryxdesign/core/Text";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Badge } from "@astryxdesign/core/Badge";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { useToast } from "@astryxdesign/core/Toast";
import { api, type RagDocument, type RagDocumentDetail, type RagSearchResult } from "../api";
import { useI18n } from "../i18n";

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
      const full = await api<RagDocumentDetail>("GET", `/api/rag/documents/${doc.id}`);
      setDetail(full);
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
      const results = await api<RagSearchResult[]>(
        "GET",
        `/api/rag/search?q=${encodeURIComponent(searchQuery)}&project=${encodeURIComponent(LEARNING_PROJECT)}&limit=10`
      );
      setSearchResults(results);
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
        <TextInput
          label={t("common.search")}
          isLabelHidden
          placeholder={t("learning.searchPlaceholder")}
          value={searchQuery}
          onChange={(v: string) => { setSearchQuery(v); if (!v.trim()) setSearchResults(null); }}
          hasClear
        />
        <Button
          label={searching ? t("common.searching") : t("common.search")}
          variant="secondary"
          onClick={runSearch}
          isDisabled={searching || !searchQuery.trim()}
        />
      </HStack>

      {error && (
        <Card variant="red">
          <Text color="secondary">{t("common.error")}: {error}</Text>
        </Card>
      )}

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
        <Grid columns={{ minWidth: 260, repeat: "fit" }} gap={4}>
          {docs.map((d) => (
            <ClickableCard key={d.id} label={d.title} onClick={() => openDetail(d)}>
              <VStack gap={2}>
                <HStack hAlign="between" vAlign="start">
                  <Heading level={4}>{d.title}</Heading>
                  <StatusDot variant={d.enabled ? "success" : "warning"} label={d.enabled ? t("rag.docActive") : t("rag.docDisabled")} />
                </HStack>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Badge
                    variant={d.vec_count === d.chunk_count && d.chunk_count > 0 ? "neutral" : "warning"}
                    label={`${d.chunk_count} ${t("learning.chunkCount")}`}
                  />
                  <Text type="supporting" color="secondary">{d.created_at}</Text>
                </HStack>
              </VStack>
            </ClickableCard>
          ))}
        </Grid>
      )}

      <Dialog isOpen={detail !== null || detailLoading} onOpenChange={(open) => { if (!open) setDetail(null); }} purpose="form" width={640}>
        <DialogHeader title={detail?.title ?? t("common.loading")} />
        <VStack gap={3} paddingInline={5} paddingBlock={4}>
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
                      <Text type="supporting" color="secondary">
                        Chunk #{c.seq}{c.heading ? ` — ${c.heading}` : ""}
                      </Text>
                      <Text style={{ whiteSpace: "pre-wrap" }}>{c.text}</Text>
                    </VStack>
                  ))}
                </VStack>
              )}
            </VStack>
          ) : null}
        </VStack>
      </Dialog>
    </VStack>
  );
}
