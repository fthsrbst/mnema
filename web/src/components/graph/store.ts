// Graf store'u — d3-force simülasyonu + sonsuz büyüyen düğüm/kenar koleksiyonu.
// Sim rAF döngüsünü GraphCanvas sürer; burada sadece kurulum ve mutasyon yardımcıları var.

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type ForceLink } from "d3-force";
import type { GraphPayload, GraphRel } from "../../api";
import type { GraphStore, SimLink, SimNode } from "./types";

/** Kenar türüne göre hedef uzunluk — related bağları biraz daha geniş nefes alır. */
const LINK_DISTANCE: Record<GraphRel, number> = {
  related: 110,
  belongs: 80,
  tagged: 70,
  logged: 80,
};

/** Çarpışma yarıçapı (world birimi) — etiket kutusu genişliğine kaba yaklaşım. */
function collideRadius(node: SimNode): number {
  const base = node.kind === "project" ? 26 : 16;
  const labelHalf = Math.min(node.label.length, 26) * 3.4;
  return Math.min(base + labelHalf, 96);
}

export function createGraphStore(): GraphStore {
  const sim = forceSimulation<SimNode>([])
    .force(
      "link",
      forceLink<SimNode, SimLink>([])
        .id((d) => d.id)
        .distance((l) => LINK_DISTANCE[l.rel])
        .strength(0.4)
    )
    .force("charge", forceManyBody<SimNode>().strength(-220).distanceMax(560))
    .force("collide", forceCollide<SimNode>().radius(collideRadius).strength(0.8))
    // Hafif merkezleme — kopuk bileşenler sonsuza savrulmasın.
    .force("x", forceX<SimNode>(0).strength(0.015))
    .force("y", forceY<SimNode>(0).strength(0.015))
    .stop(); // rAF döngüsünü canvas yönetir; d3'ün kendi timer'ı hiç çalışmaz.

  return { nodes: new Map(), links: [], linkKeys: new Set(), offsets: new Map(), sim };
}

/** Düğüm/kenar listelerini simülasyona yeniden bağlar (yeni eklemelerden sonra çağrılır). */
function syncSim(store: GraphStore): void {
  store.sim.nodes([...store.nodes.values()]);
  (store.sim.force("link") as ForceLink<SimNode, SimLink>).links(store.links);
}

/**
 * API payload'ını grafa ekler. Yeni düğümler `origin` çevresine hafif saçılımla
 * doğar (yoksa merkeze). Var olan düğümler pozisyonunu korur, degree'si tazelenir.
 */
export function addPayload(store: GraphStore, payload: GraphPayload, origin?: { x: number; y: number }): number {
  const cx = origin?.x ?? 0;
  const cy = origin?.y ?? 0;
  const fresh = payload.nodes.filter((n) => !store.nodes.has(n.id));
  let added = 0;

  for (const n of payload.nodes) {
    const existing = store.nodes.get(n.id);
    if (existing) {
      existing.degree = n.degree;
      existing.sublabel = n.sublabel;
      continue;
    }
    const i = added;
    const angle = (i / Math.max(1, fresh.length)) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
    const radius = origin ? 70 + Math.random() * 60 : 40 + Math.random() * 260;
    store.nodes.set(n.id, {
      ...n,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      born: performance.now(),
    });
    added++;
  }

  for (const e of payload.edges) {
    const key = `${e.from}|${e.to}|${e.rel}`;
    const reverse = `${e.to}|${e.from}|${e.rel}`;
    if (store.linkKeys.has(key) || store.linkKeys.has(reverse)) continue;
    if (!store.nodes.has(e.from) || !store.nodes.has(e.to)) continue;
    store.linkKeys.add(key);
    store.links.push({ source: e.from, target: e.to, rel: e.rel, key });
  }

  syncSim(store);
  return added;
}

/** Simülasyonu yeniden ısıtır — canvas döngüsü alpha > eşik olduğu sürece tick atar. */
export function reheat(store: GraphStore, alpha = 0.5): void {
  store.sim.alpha(Math.max(store.sim.alpha(), alpha));
}

/** İlk seed sonrası: layout'u ekrana gelmeden stabilize et (ilk kare zaten oturmuş görünür). */
export function settle(store: GraphStore, ticks = 160): void {
  for (let i = 0; i < ticks && store.sim.alpha() > store.sim.alphaMin(); i++) store.sim.tick();
}
