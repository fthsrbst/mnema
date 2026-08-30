import { randomUUID } from "node:crypto";
import http from "node:http";

interface StoredEpisode {
  uuid: string;
  content: string;
  created_at: string;
  metadata: Record<string, unknown>;
  polls: number;
  neverProcesses: boolean;
}

interface StoredGraph {
  graph_id: string;
  name: string;
  description: string;
  uuid: string;
  created_at: string;
  episodes: Map<string, StoredEpisode>;
}

export interface FakeZepSnapshot {
  graphs: number;
  episodes: number;
  requests: number;
  graphCreates: number;
  graphDeleteCalls: number;
  episodeCreates: number;
  episodeDeletes: number;
  authFailures: number;
}

export interface FakeZepServer {
  baseUrl: string;
  failNextSearch(count?: number): void;
  failNextGraphDelete(count?: number): void;
  stallNextEpisode(): void;
  setSearchDelay(ms: number): void;
  snapshot(): FakeZepSnapshot;
  close(): Promise<void>;
}

function tokens(value: string): Set<string> {
  return new Set(
    (value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase("en-US")
      .match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((token) => token.length > 1)
  );
}

function overlap(query: string, content: string): number {
  const queryTokens = tokens(query);
  const contentTokens = tokens(content);
  let count = 0;
  for (const token of queryTokens) if (contentTokens.has(token)) count++;
  return queryTokens.size === 0 || contentTokens.size === 0
    ? 0
    : count / Math.sqrt(queryTokens.size * contentTokens.size);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isObject(parsed)) throw new Error("request body must be an object");
  return parsed;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function graphResponse(graph: StoredGraph): Record<string, unknown> {
  return {
    graph_id: graph.graph_id,
    name: graph.name,
    description: graph.description,
    uuid: graph.uuid,
    created_at: graph.created_at,
    id: 1,
    project_uuid: "fake-project",
  };
}

function episodeResponse(episode: StoredEpisode): Record<string, unknown> {
  return {
    uuid: episode.uuid,
    content: episode.content,
    created_at: episode.created_at,
    metadata: episode.metadata,
    processed: !episode.neverProcesses && episode.polls >= 2,
    source: "text",
  };
}

function totalEpisodes(graphs: Map<string, StoredGraph>): number {
  let count = 0;
  for (const graph of graphs.values()) count += graph.episodes.size;
  return count;
}

function findEpisode(
  graphs: Map<string, StoredGraph>,
  episodeId: string
): { graph: StoredGraph; episode: StoredEpisode } | null {
  for (const graph of graphs.values()) {
    const episode = graph.episodes.get(episodeId);
    if (episode) return { graph, episode };
  }
  return null;
}

export async function startFakeZepServer(apiKey = "test-key"): Promise<FakeZepServer> {
  const graphs = new Map<string, StoredGraph>();
  let requestCount = 0;
  let graphCreates = 0;
  let graphDeleteCalls = 0;
  let episodeCreates = 0;
  let episodeDeletes = 0;
  let authFailures = 0;
  let failingSearches = 0;
  let failingGraphDeletes = 0;
  let stallFollowingEpisode = false;
  let searchDelayMs = 0;

  const server = http.createServer(async (req, res) => {
    requestCount++;
    try {
      if (req.headers.authorization !== `Api-Key ${apiKey}`) {
        authFailures++;
        sendJson(res, 401, { detail: "invalid token" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";

      if (method === "POST" && url.pathname === "/api/v2/graph/create") {
        const body = await readJson(req);
        if (typeof body.graph_id !== "string" || body.graph_id.trim() === "") {
          sendJson(res, 400, { detail: "graph_id is required" });
          return;
        }
        if (graphs.has(body.graph_id)) {
          sendJson(res, 409, { detail: "graph already exists" });
          return;
        }
        const graph: StoredGraph = {
          graph_id: body.graph_id,
          name: typeof body.name === "string" ? body.name : body.graph_id,
          description: typeof body.description === "string" ? body.description : "",
          uuid: randomUUID(),
          created_at: new Date().toISOString(),
          episodes: new Map(),
        };
        graphCreates++;
        graphs.set(graph.graph_id, graph);
        sendJson(res, 201, graphResponse(graph));
        return;
      }

      if (method === "POST" && url.pathname === "/api/v2/graph/search") {
        if (failingSearches > 0) {
          failingSearches--;
          sendJson(res, 503, { detail: "temporary search failure" });
          return;
        }
        if (searchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, searchDelayMs));
        if (res.destroyed) return;
        const body = await readJson(req);
        const graph = typeof body.graph_id === "string" ? graphs.get(body.graph_id) : undefined;
        if (!graph) {
          sendJson(res, 404, { detail: "graph not found" });
          return;
        }
        if (body.scope !== "episodes") {
          sendJson(res, 400, { detail: "fake server supports episode search only" });
          return;
        }
        const query = String(body.query ?? "");
        const limit = typeof body.limit === "number" ? body.limit : 10;
        if ([...query].length > 400) {
          sendJson(res, 400, { detail: "query exceeds 400 characters" });
          return;
        }
        if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
          sendJson(res, 400, { detail: "limit must be an integer from 1 to 50" });
          return;
        }
        const episodes = [...graph.episodes.values()]
          .filter((episode) => !episode.neverProcesses && episode.polls >= 2)
          .map((episode) => ({ episode, score: overlap(query, episode.content) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || a.episode.uuid.localeCompare(b.episode.uuid))
          .slice(0, limit)
          .map(({ episode, score }, index) => ({
            ...episodeResponse(episode),
            score,
            relevance: score,
            selection_rank: index + 1,
          }));
        sendJson(res, 200, {
          episodes,
          edges: [],
          nodes: [],
          response: { server_latency_ms: 7 },
        });
        return;
      }

      if (method === "POST" && url.pathname === "/api/v2/graph") {
        const body = await readJson(req);
        const graph = typeof body.graph_id === "string" ? graphs.get(body.graph_id) : undefined;
        if (!graph) {
          sendJson(res, 404, { detail: "graph not found" });
          return;
        }
        if (body.type !== "text" || typeof body.data !== "string" || body.data.trim() === "") {
          sendJson(res, 400, { detail: "text data is required" });
          return;
        }
        if (body.data.length > 10_000) {
          sendJson(res, 400, { detail: "text data exceeds 10000 characters" });
          return;
        }
        if (body.data.includes("\uFFFD")) {
          sendJson(res, 400, { detail: "text data contains replacement characters" });
          return;
        }
        if (
          typeof body.created_at !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(
            body.created_at
          )
        ) {
          sendJson(res, 400, { detail: "created_at must be UTC ISO 8601" });
          return;
        }
        const episode: StoredEpisode = {
          uuid: randomUUID(),
          content: body.data,
          created_at:
            typeof body.created_at === "string" ? body.created_at : new Date().toISOString(),
          metadata: isObject(body.metadata) ? body.metadata : {},
          polls: 0,
          neverProcesses: stallFollowingEpisode,
        };
        stallFollowingEpisode = false;
        episodeCreates++;
        graph.episodes.set(episode.uuid, episode);
        sendJson(res, 202, episodeResponse(episode));
        return;
      }

      const episodeMatch = url.pathname.match(/^\/api\/v2\/graph\/episodes\/([^/]+)$/);
      if (episodeMatch) {
        const episodeId = decodeURIComponent(episodeMatch[1]);
        const found = findEpisode(graphs, episodeId);
        if (method === "GET") {
          if (!found) {
            sendJson(res, 404, { detail: "episode not found" });
          } else {
            found.episode.polls++;
            sendJson(res, 200, episodeResponse(found.episode));
          }
          return;
        }
        if (method === "DELETE") {
          if (!found) {
            sendJson(res, 404, { detail: "episode not found" });
          } else {
            episodeDeletes++;
            found.graph.episodes.delete(episodeId);
            sendJson(res, 200, { message: "episode deleted" });
          }
          return;
        }
      }

      const graphMatch = url.pathname.match(/^\/api\/v2\/graph\/([^/]+)$/);
      if (graphMatch) {
        const graphId = decodeURIComponent(graphMatch[1]);
        const graph = graphs.get(graphId);
        if (method === "GET") {
          if (!graph) sendJson(res, 404, { detail: "graph not found" });
          else sendJson(res, 200, graphResponse(graph));
          return;
        }
        if (method === "DELETE") {
          graphDeleteCalls++;
          if (failingGraphDeletes > 0) {
            failingGraphDeletes--;
            sendJson(res, 503, { detail: "temporary graph cleanup failure" });
            return;
          }
          if (!graph) sendJson(res, 404, { detail: "graph not found" });
          else {
            graphs.delete(graphId);
            sendJson(res, 200, { message: `Graph with ID ${graphId} successfully deleted.` });
          }
          return;
        }
      }

      sendJson(res, 404, { detail: `${method} ${url.pathname} not found` });
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, { detail: error instanceof Error ? error.message : String(error) });
      } else {
        res.destroy();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake Zep server did not bind a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    failNextSearch(count = 1): void {
      failingSearches = count;
    },
    failNextGraphDelete(count = 1): void {
      failingGraphDeletes = count;
    },
    stallNextEpisode(): void {
      stallFollowingEpisode = true;
    },
    setSearchDelay(ms: number): void {
      searchDelayMs = ms;
    },
    snapshot(): FakeZepSnapshot {
      return {
        graphs: graphs.size,
        episodes: totalEpisodes(graphs),
        requests: requestCount,
        graphCreates,
        graphDeleteCalls,
        episodeCreates,
        episodeDeletes,
        authFailures,
      };
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
