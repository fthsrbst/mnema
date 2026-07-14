// İlişki Grafiği view'ı — tuval + overlay araç çubuğu + detay paneli.
// Veri akışı: seed → tuval; çift tık/panel → neighbors ile sonsuz genişleme.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  fetchGraphNeighbors,
  fetchGraphNode,
  fetchGraphSeed,
  parseGraphId,
  type GraphNodeKind,
  type Memory,
  type RagDocumentDetail,
} from "../api";
import { GraphCanvas, type GraphCanvasHandle } from "../components/graph/GraphCanvas";
import { addPayload, createGraphStore, reheat, settle } from "../components/graph/store";
import { ALL_KINDS, type GraphStore, type KindFilter } from "../components/graph/types";
import { Icon } from "../components/icons/Icons";
import { ASCII_LOADING } from "../components/ui/Ascii";
import { Button, IconButton } from "../components/ui/Button";
import { Dither } from "../components/ui/Dither";
import { EmptyState } from "../components/ui/EmptyState";
import { Panel } from "../components/ui/Panel";
import { Tag } from "../components/ui/Tag";
import { HStack, VStack } from "../components/ui/Stack";
import { Text } from "../components/ui/Typography";
import { useToast } from "../components/ui/useToast";
import { useI18n, type TKey } from "../i18n";

const EMPTY_ART = String.raw`
      ■────────□
     /
    ■     ■──□
     \   /
      ■─■   NO GRAPH
         \
          □
`;

const KIND_LABEL: Record<GraphNodeKind, TKey> = {
  project: "graph.kindProject",
  memory: "graph.kindMemory",
  document: "graph.kindDocument",
  session: "graph.kindSession",
  tag: "graph.kindTag",
};

const KIND_COLOR: Record<GraphNodeKind, string> = {
  project: "var(--fg)",
  memory: "var(--accent)",
  document: "var(--fg)",
  session: "var(--fg-dim)",
  tag: "var(--fg-faint)",
};

interface SearchHit {
  id: string;
  kind: GraphNodeKind;
  label: string;
  inGraph: boolean;
}

export function Graph() {
  const { t } = useI18n();
  const toast = useToast();
  const storeRef = useRef<GraphStore | null>(null);
  if (!storeRef.current) storeRef.current = createGraphStore();
  const store = storeRef.current;
  const canvas = useRef<GraphCanvasHandle>(null);
  const seeded = useRef(false);

  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [counts, setCounts] = useState({ nodes: 0, edges: 0 });
  const [zoomPct, setZoomPct] = useState(100);
  const [filters, setFilters] = useState<KindFilter>({ project: true, memory: true, document: true, session: true, tag: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailBody, setDetailBody] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [expandingId, setExpandingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const selectedRef = useRef<string | null>(null);

  const refreshCounts = useCallback(() => {
    setCounts({ nodes: store.nodes.size, edges: store.links.length });
  }, [store]);

  // --- seed yükle ---
  useEffect(() => {
    if (seeded.current) return; // StrictMode çift çalıştırma koruması
    seeded.current = true;
    fetchGraphSeed(24)
      .then((payload) => {
        addPayload(store, payload);
        reheat(store, 1);
        settle(store); // ekrana gelmeden yerleşsin
        refreshCounts();
        setLoading(false);
        canvas.current?.fit();
      })
      .catch(() => {
        setFailed(true);
        setLoading(false);
      });
  }, [store, refreshCounts]);

  // --- seçim + detay gövdesi ---
  const select = useCallback(
    (id: string | null) => {
      selectedRef.current = id;
      setSelectedId(id);
      setDetailBody(null);
      if (!id) return;
      const { kind, key } = parseGraphId(id);
      if (kind !== "memory" && kind !== "document") return;
      setDetailLoading(true);
      const req =
        kind === "memory"
          ? api<Memory>("GET", `/api/memory/${key}`).then((m) => m.body)
          : api<RagDocumentDetail>("GET", `/api/rag/documents/${key}`).then((d) => d.chunks[0]?.text ?? "");
      req
        .then((body) => {
          if (selectedRef.current === id) setDetailBody(body.slice(0, 500));
        })
        .catch(() => undefined)
        .finally(() => {
          if (selectedRef.current === id) setDetailLoading(false);
        });
    },
    []
  );

  // --- genişletme (çift tık / panel butonu) ---
  const expand = useCallback(
    async (id: string) => {
      const node = store.nodes.get(id);
      if (!node || expandingId) return;
      const { kind, key } = parseGraphId(id);
      const offset = store.offsets.get(id) ?? 0;
      setExpandingId(id);
      try {
        const payload = await fetchGraphNeighbors(kind, key, offset, 30);
        store.offsets.set(id, offset + 30);
        node.more = payload.more;
        addPayload(store, payload, { x: node.x ?? 0, y: node.y ?? 0 });
        reheat(store, 0.6);
        refreshCounts();
        canvas.current?.redraw();
      } catch {
        toast({ body: t("common.loadFailed"), type: "error" });
      } finally {
        setExpandingId(null);
      }
    },
    [store, expandingId, refreshCounts, toast, t]
  );

  // --- arama: istemci-içi (proje/etiket) + /api/memory/search ---
  useEffect(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(async () => {
      const local: SearchHit[] = [...store.nodes.values()]
        .filter((n) => (n.kind === "project" || n.kind === "tag") && n.label.toLowerCase().includes(q))
        .slice(0, 5)
        .map((n) => ({ id: n.id, kind: n.kind, label: n.label, inGraph: true }));
      let remote: SearchHit[] = [];
      try {
        const mems = await api<Memory[]>("GET", `/api/memory/search?q=${encodeURIComponent(query.trim())}&limit=6`);
        remote = mems.map((m) => ({
          id: `memory:${m.id}`,
          kind: "memory" as const,
          label: m.title,
          inGraph: store.nodes.has(`memory:${m.id}`),
        }));
      } catch {
        // arama başarısızsa yerel sonuçlarla yetin
      }
      const seen = new Set(local.map((h) => h.id));
      setHits([...local, ...remote.filter((h) => !seen.has(h.id))]);
    }, 250);
    return () => clearTimeout(timer);
  }, [query, store]);

  const pick = useCallback(
    async (hit: SearchHit) => {
      setQuery("");
      setHits([]);
      try {
        if (!store.nodes.has(hit.id)) {
          const { kind, key } = parseGraphId(hit.id);
          const node = await fetchGraphNode(kind, key);
          const center = canvas.current?.centerWorld() ?? { x: 0, y: 0 };
          addPayload(store, { nodes: [node], edges: [], more: 0 }, center);
          reheat(store, 0.3);
          refreshCounts();
        }
        canvas.current?.focusNode(hit.id);
        select(hit.id);
      } catch {
        toast({ body: t("common.loadFailed"), type: "error" });
      }
    },
    [store, refreshCounts, select, toast, t]
  );

  // --- klavye: +/- zoom, 0 fit, Esc bırak ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.key === "+" || e.key === "=") canvas.current?.zoomBy(1.25);
      else if (e.key === "-") canvas.current?.zoomBy(0.8);
      else if (e.key === "0") canvas.current?.fit();
      else if (e.key === "Escape") select(null);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [select]);

  const onZoomChange = useCallback((k: number) => setZoomPct(Math.round(k * 100)), []);

  const selectedNode = selectedId ? store.nodes.get(selectedId) : undefined;
  const expanded = selectedId ? store.offsets.has(selectedId) : false;
  const remaining = selectedNode?.more ?? 0;
  const showExpandButton = selectedNode && (!expanded || remaining > 0);
  const relKinds = useMemo(
    () =>
      [
        { rel: "related", label: t("graph.relRelated"), dash: "solid" },
        { rel: "belongs", label: t("graph.relBelongs"), dash: "dotted" },
        { rel: "tagged", label: t("graph.relTagged"), dash: "dashed" },
        { rel: "logged", label: t("graph.relLogged"), dash: "dashed-wide" },
      ] as const,
    [t]
  );

  return (
    <div className="graph-view">
      <Dither cell={7} opacity={0.05} />
      <GraphCanvas
        ref={canvas}
        store={store}
        filters={filters}
        selectedId={selectedId}
        onSelect={select}
        onExpand={expand}
        onZoomChange={onZoomChange}
        ariaLabel={t("graph.canvasLabel")}
      />

      {/* --- üst araç çubuğu --- */}
      <div className="graph-toolbar">
        <div className="graph-search">
          <input
            className="input"
            value={query}
            placeholder={t("graph.searchPlaceholder")}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t("common.search")}
          />
          {query.trim().length >= 2 && (
            <div className="graph-search-results">
              {hits.length === 0 && <span className="graph-search-empty">{t("graph.noResults")}</span>}
              {hits.map((h) => (
                <button key={h.id} type="button" className="graph-search-hit" onClick={() => pick(h)}>
                  <span className="graph-kind-mark" style={{ background: KIND_COLOR[h.kind] }} />
                  <span className="graph-search-hit-label">{h.label}</span>
                  {h.inGraph && <span className="graph-search-hit-note">{t("graph.inGraph")}</span>}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="graph-filters" role="group" aria-label={t("graph.legend")}>
          {ALL_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="graph-filter"
              data-on={filters[kind]}
              onClick={() => setFilters((f) => ({ ...f, [kind]: !f[kind] }))}
              aria-pressed={filters[kind]}
            >
              <span className="graph-kind-mark" style={{ background: KIND_COLOR[kind] }} />
              {t(KIND_LABEL[kind])}
            </button>
          ))}
        </div>

        <div className="graph-zoom">
          <IconButton icon={<Icon name="fit" size={12} />} label={t("graph.fit")} size="sm" onClick={() => canvas.current?.fit()} />
          <IconButton icon={<Icon name="minus" size={12} />} label={t("graph.zoomOut")} size="sm" onClick={() => canvas.current?.zoomBy(0.8)} />
          <span className="graph-zoom-pct">{zoomPct}%</span>
          <IconButton icon={<Icon name="plus" size={12} />} label={t("graph.zoomIn")} size="sm" onClick={() => canvas.current?.zoomBy(1.25)} />
        </div>

        <span className="graph-counter">
          {counts.nodes} {t("graph.nodes")} · {counts.edges} {t("graph.edges")}
        </span>
      </div>

      {/* --- legend (kenar türleri) + ipucu --- */}
      <div className="graph-legend">
        {relKinds.map((r) => (
          <span key={r.rel} className="graph-legend-item">
            <span className={`graph-legend-line graph-legend-line--${r.dash}`} />
            {r.label}
          </span>
        ))}
        <span className="graph-hint">{t("graph.hint")}</span>
      </div>

      {/* --- detay paneli --- */}
      {selectedNode && (
        <div className="graph-detail">
          <Panel raised>
            <VStack gap={3}>
              <VStack gap={1}>
                <HStack gap={2} vAlign="center" wrap="wrap">
                  <Tag variant={selectedNode.kind === "memory" ? "accent" : "default"}>{t(KIND_LABEL[selectedNode.kind])}</Tag>
                  <Text type="supporting" color="secondary">
                    {selectedNode.degree} {t("graph.degree")}
                  </Text>
                </HStack>
                <Text style={{ fontWeight: 600, wordBreak: "break-word" }}>{selectedNode.label}</Text>
                {selectedNode.sublabel && (
                  <Text type="supporting" color="secondary">
                    {selectedNode.sublabel}
                  </Text>
                )}
                {selectedNode.project && (
                  <Text type="supporting" color="secondary">
                    {t("graph.detailProject")}: {selectedNode.project}
                  </Text>
                )}
              </VStack>

              {detailLoading && (
                <Text type="supporting" color="secondary">
                  {t("graph.bodyLoading")}
                </Text>
              )}
              {detailBody && (
                <pre className="graph-detail-body">{detailBody}</pre>
              )}

              <VStack gap={2}>
                {showExpandButton && (
                  <Button
                    label={
                      expandingId === selectedNode.id
                        ? t("graph.expanding")
                        : expanded
                          ? `${t("graph.loadMore")} (${remaining})`
                          : `${t("graph.expand")} (${selectedNode.degree})`
                    }
                    variant="primary"
                    size="sm"
                    disabled={expandingId !== null}
                    onClick={() => expand(selectedNode.id)}
                  />
                )}
                <Button label={t("graph.deselect")} variant="ghost" size="sm" onClick={() => select(null)} />
              </VStack>
            </VStack>
          </Panel>
        </div>
      )}

      {/* --- yükleniyor / boş / hata --- */}
      {loading && (
        <div className="graph-status">
          <pre className="ascii-art">{ASCII_LOADING}</pre>
          <Text type="supporting" color="secondary">
            {t("graph.loading")}
          </Text>
        </div>
      )}
      {!loading && failed && (
        <div className="graph-status">
          <EmptyState title={t("graph.loadFailed")} description={t("common.loadFailed")} art={EMPTY_ART} />
        </div>
      )}
      {!loading && !failed && counts.nodes === 0 && (
        <div className="graph-status">
          <EmptyState title={t("graph.empty")} description={t("graph.emptyDesc")} art={EMPTY_ART} />
        </div>
      )}
    </div>
  );
}
