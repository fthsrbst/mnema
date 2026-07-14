import { getDb } from "./db.js";

/**
 * İlişki grafiği: hub'daki varlıkları (proje, hafıza, doküman, oturum, etiket)
 * düğüm; aralarındaki bağları kenar olarak döner. Tasarım ilkesi "sonsuz büyüme":
 * graf hiçbir zaman komple dönmez — seed() küçük bir çekirdek verir, UI her
 * düğümü neighbors() ile tembelce genişletir (sayfalama dahil). Böylece veri
 * büyüdükçe API sabit maliyetli kalır.
 */

export type GraphNodeKind = "project" | "memory" | "document" | "session" | "tag";

export type GraphRel = "related" | "belongs" | "tagged" | "logged";

export interface GraphNode {
  /** "<kind>:<key>" — memory/document/session için sayısal id, project/tag için ad. */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** Tür/tarih gibi ikincil bilgi (UI alt satırı). */
  sublabel?: string;
  project?: string | null;
  /** Toplam komşu sayısı — UI "genişletilebilir mi + kaç bağ var" bundan bilir. */
  degree: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  rel: GraphRel;
}

export interface GraphPayload {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Sayfalama: bu genişletmede dönmeyen kalan komşu sayısı. */
  more: number;
}

const nodeId = (kind: GraphNodeKind, key: string | number): string => `${kind}:${key}`;

/** Tarihin gün kısmı — sublabel'lar için. */
const day = (ts: string | null | undefined): string => (ts ?? "").slice(0, 10);

interface MemoryRow {
  id: number;
  uid: string;
  type: string;
  title: string;
  project: string | null;
  tags: string;
  related: string;
  updated_at: string;
}

function parseArr(json: string | null | undefined): string[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Bir memory'nin graf derecesi: related (çift yön) + etiketler + proje bağı.
 * related tek yönlü SAKLANIR (bildiren kayıtta uid listesi) ama graf yönsüzdür —
 * gelen bağlar json_each ile taranır.
 */
function memoryDegree(row: MemoryRow): number {
  const db = getDb();
  const incoming = (
    db
      .prepare("SELECT COUNT(*) AS n FROM memories m, json_each(m.related) WHERE json_each.value = ? AND m.id != ?")
      .get(row.uid, row.id) as { n: number }
  ).n;
  const outgoing = parseArr(row.related).length;
  return incoming + outgoing + parseArr(row.tags).length + (row.project ? 1 : 0);
}

function memoryNode(row: MemoryRow): GraphNode {
  return {
    id: nodeId("memory", row.id),
    kind: "memory",
    label: row.title,
    sublabel: `${row.type} · ${day(row.updated_at)}`,
    project: row.project,
    degree: memoryDegree(row),
  };
}

function projectNode(name: string): GraphNode {
  const db = getDb();
  const n = (q: string) => (db.prepare(q).get(name) as { n: number }).n;
  const memories = n("SELECT COUNT(*) AS n FROM memories WHERE project = ?");
  const documents = n("SELECT COUNT(*) AS n FROM documents WHERE project = ?");
  const sessions = n("SELECT COUNT(*) AS n FROM session_logs WHERE project = ?");
  return {
    id: nodeId("project", name),
    kind: "project",
    label: name,
    sublabel: `${memories} mem · ${documents} doc · ${sessions} ses`,
    degree: memories + documents + sessions,
  };
}

function tagNode(tag: string): GraphNode {
  const n = (
    getDb()
      .prepare("SELECT COUNT(*) AS n FROM memories m, json_each(m.tags) WHERE json_each.value = ?")
      .get(tag) as { n: number }
  ).n;
  return { id: nodeId("tag", tag), kind: "tag", label: `#${tag}`, degree: n };
}

/**
 * Çekirdek graf: tüm projeler + en çok kullanılan etiketler + proje↔etiket
 * eş-geçiş kenarları (projenin bir memory'si o etiketi taşıyorsa). Amaç:
 * ilk açılışta anlamlı, küçük bir "harita" — detaylar genişletmeyle gelir.
 */
export function graphSeed(tagLimit = 24): GraphPayload {
  const db = getDb();
  const projects = (db.prepare("SELECT name FROM projects ORDER BY updated_at DESC").all() as { name: string }[]).map(
    (r) => projectNode(r.name)
  );
  const tags = db
    .prepare(
      `SELECT json_each.value AS tag, COUNT(*) AS n FROM memories m, json_each(m.tags)
       GROUP BY tag ORDER BY n DESC LIMIT ?`
    )
    .all(tagLimit) as { tag: string; n: number }[];
  const tagNodes = tags.map((t) => ({ id: nodeId("tag", t.tag), kind: "tag" as const, label: `#${t.tag}`, degree: t.n }));

  const edges: GraphEdge[] = [];
  const coEdges = db
    .prepare(
      `SELECT DISTINCT m.project AS project, json_each.value AS tag
       FROM memories m, json_each(m.tags) WHERE m.project IS NOT NULL`
    )
    .all() as { project: string; tag: string }[];
  const projectNames = new Set(projects.map((p) => p.label));
  const tagNames = new Set(tags.map((t) => t.tag));
  for (const e of coEdges) {
    if (projectNames.has(e.project) && tagNames.has(e.tag)) {
      edges.push({ from: nodeId("project", e.project), to: nodeId("tag", e.tag), rel: "tagged" });
    }
  }
  return { nodes: [...projects, ...tagNodes], edges, more: 0 };
}

/** Tek düğümü kimliğinden çözer (UI derin-link/yenileme için). */
export function graphNode(kind: GraphNodeKind, key: string): GraphNode | null {
  const db = getDb();
  switch (kind) {
    case "project":
      return db.prepare("SELECT 1 FROM projects WHERE name = ?").get(key) ? projectNode(key) : null;
    case "tag":
      return tagNode(key);
    case "memory": {
      const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(Number(key)) as MemoryRow | undefined;
      return row ? memoryNode(row) : null;
    }
    case "document": {
      const row = db.prepare("SELECT id, title, project, created_at FROM documents WHERE id = ?").get(Number(key)) as
        | { id: number; title: string; project: string | null; created_at: string }
        | undefined;
      if (!row) return null;
      return {
        id: nodeId("document", row.id),
        kind: "document",
        label: row.title,
        sublabel: `doc · ${day(row.created_at)}`,
        project: row.project,
        degree: row.project ? 1 : 0,
      };
    }
    case "session": {
      const row = db.prepare("SELECT id, project, summary, created_at FROM session_logs WHERE id = ?").get(Number(key)) as
        | { id: number; project: string | null; summary: string; created_at: string }
        | undefined;
      if (!row) return null;
      return {
        id: nodeId("session", row.id),
        kind: "session",
        label: row.summary.split("\n")[0].slice(0, 60),
        sublabel: `session · ${day(row.created_at)}`,
        project: row.project,
        degree: row.project ? 1 : 0,
      };
    }
  }
}

/**
 * Bir düğümün komşuları — grafın büyüme birimi. offset/limit tek birleşik liste
 * üzerinde çalışır (deterministik sıra), `more` kalanı söyler; UI "N bağ daha"
 * düğmesiyle aynı düğümü tekrar genişletir.
 */
export function graphNeighbors(kind: GraphNodeKind, key: string, offset = 0, limit = 30): GraphPayload {
  const db = getDb();
  const self = nodeId(kind, key);
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Komşu listesi önce hafif (id + rel) toplanır; sayfa dilimi için node üretilir.
  type Neighbor = { kind: GraphNodeKind; key: string; rel: GraphRel };
  const all: Neighbor[] = [];

  switch (kind) {
    case "project": {
      const mems = db.prepare("SELECT id FROM memories WHERE project = ? ORDER BY updated_at DESC").all(key) as { id: number }[];
      const docs = db.prepare("SELECT id FROM documents WHERE project = ? ORDER BY updated_at DESC").all(key) as { id: number }[];
      const sess = db.prepare("SELECT id FROM session_logs WHERE project = ? ORDER BY created_at DESC").all(key) as { id: number }[];
      all.push(
        ...mems.map((m) => ({ kind: "memory" as const, key: String(m.id), rel: "belongs" as const })),
        ...docs.map((d) => ({ kind: "document" as const, key: String(d.id), rel: "belongs" as const })),
        ...sess.map((s) => ({ kind: "session" as const, key: String(s.id), rel: "logged" as const }))
      );
      break;
    }
    case "memory": {
      const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(Number(key)) as MemoryRow | undefined;
      if (!row) return { nodes: [], edges: [], more: 0 };
      if (row.project) all.push({ kind: "project", key: row.project, rel: "belongs" });
      for (const tag of parseArr(row.tags)) all.push({ kind: "tag", key: tag, rel: "tagged" });
      // giden related bağları (uid → yerel id)
      const uidStmt = db.prepare("SELECT id FROM memories WHERE uid = ?");
      for (const uid of parseArr(row.related)) {
        const hit = uidStmt.get(uid) as { id: number } | undefined;
        if (hit) all.push({ kind: "memory", key: String(hit.id), rel: "related" });
      }
      // gelen related bağları
      const incoming = db
        .prepare("SELECT m.id FROM memories m, json_each(m.related) WHERE json_each.value = ? AND m.id != ?")
        .all(row.uid, row.id) as { id: number }[];
      for (const inc of incoming) all.push({ kind: "memory", key: String(inc.id), rel: "related" });
      break;
    }
    case "tag": {
      const mems = db
        .prepare("SELECT m.id FROM memories m, json_each(m.tags) WHERE json_each.value = ? ORDER BY m.updated_at DESC")
        .all(key) as { id: number }[];
      all.push(...mems.map((m) => ({ kind: "memory" as const, key: String(m.id), rel: "tagged" as const })));
      break;
    }
    case "document":
    case "session": {
      const table = kind === "document" ? "documents" : "session_logs";
      const row = db.prepare(`SELECT project FROM ${table} WHERE id = ?`).get(Number(key)) as
        | { project: string | null }
        | undefined;
      if (row?.project) all.push({ kind: "project", key: row.project, rel: kind === "session" ? "logged" : "belongs" });
      break;
    }
  }

  // Aynı komşu birden çok bağla gelebilir (ör. iki yönde related) — tekilleştir.
  const seen = new Set<string>();
  const unique = all.filter((n) => {
    const id = nodeId(n.kind, n.key);
    if (id === self || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const page = unique.slice(offset, offset + limit);
  for (const n of page) {
    const node = graphNode(n.kind, n.key);
    if (!node) continue;
    nodes.push(node);
    edges.push({ from: self, to: node.id, rel: n.rel });
  }
  return { nodes, edges, more: Math.max(0, unique.length - offset - limit) };
}
