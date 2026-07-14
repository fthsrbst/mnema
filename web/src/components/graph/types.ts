// İlişki grafiği — istemci tarafı tipler. API tipleri api.ts'te; burası simülasyon katmanı.

import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { GraphNode, GraphNodeKind, GraphRel } from "../../api";

/** d3-force simülasyonuna giren düğüm — API düğümü + konum + çizim önbellekleri. */
export interface SimNode extends GraphNode, SimulationNodeDatum {
  /** Doğum anı (performance.now) — spawn animasyonu bundan hesaplanır. */
  born: number;
  /** Son expand yanıtındaki kalan komşu sayısı (panel "Load more" bundan). */
  more?: number;
  /** Ölçülmüş (gerekirse kısaltılmış) etiket metni + genişliği — canvas ölçüm cache'i. */
  labelText?: string;
  labelW?: number;
  /** Son çizimdeki ekran-uzayı vuruş kutusu (hit-test için). */
  hitX?: number;
  hitY?: number;
  hitW?: number;
  hitH?: number;
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  rel: GraphRel;
  /** "from|to|rel" — tekilleştirme anahtarı. */
  key: string;
}

/** Grafın tamamı — React state DEĞİL; canvas + sim doğrudan mutasyonla çalışır. */
export interface GraphStore {
  nodes: Map<string, SimNode>;
  links: SimLink[];
  linkKeys: Set<string>;
  /** Düğüm başına expand sayfalama offset'i. */
  offsets: Map<string, number>;
  sim: Simulation<SimNode, SimLink>;
}

export type KindFilter = Record<GraphNodeKind, boolean>;

export const ALL_KINDS: GraphNodeKind[] = ["project", "memory", "document", "session", "tag"];
