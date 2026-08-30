import http from "node:http";

interface StoredMemory {
  id: string;
  memory: string;
  user_id: string;
  run_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface FakeEvent {
  polls: number;
  failed: boolean;
}

export interface FakeMem0Snapshot {
  memories: number;
  requests: number;
  cleanupCalls: number;
  authFailures: number;
}

export interface FakeMem0Server {
  baseUrl: string;
  failNextSearch(count?: number): void;
  failNextCleanup(count?: number): void;
  failNextEvent(): void;
  setSearchDelay(ms: number): void;
  snapshot(): FakeMem0Snapshot;
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
  return queryTokens.size === 0 || contentTokens.size === 0 ? 0 : count / Math.sqrt(queryTokens.size * contentTokens.size);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matchesFilters(memory: StoredMemory, filters: unknown): boolean {
  if (!isObject(filters)) return false;
  if (Array.isArray(filters.AND)) return filters.AND.every((filter) => matchesFilters(memory, filter));
  if (typeof filters.user_id === "string" && memory.user_id !== filters.user_id) return false;
  if (typeof filters.run_id === "string" && memory.run_id !== filters.run_id) return false;
  return true;
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

export async function startFakeMem0Server(apiKey = "test-key"): Promise<FakeMem0Server> {
  const memories = new Map<string, StoredMemory>();
  const events = new Map<string, FakeEvent>();
  let idCounter = 0;
  let requestCount = 0;
  let cleanupCalls = 0;
  let authFailures = 0;
  let failingSearches = 0;
  let failingCleanups = 0;
  let failFollowingEvent = false;
  let searchDelayMs = 0;

  const server = http.createServer(async (req, res) => {
    requestCount++;
    try {
      if (req.headers.authorization !== `Token ${apiKey}`) {
        authFailures++;
        sendJson(res, 401, { detail: "invalid token" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";

      if (method === "POST" && url.pathname === "/v3/memories/add/") {
        const body = await readJson(req);
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const first = messages.find((message) => isObject(message) && typeof message.content === "string");
        if (!isObject(first) || typeof first.content !== "string") {
          sendJson(res, 400, { detail: "messages required" });
          return;
        }
        const id = `mem-${++idCounter}`;
        const eventId = `event-${idCounter}`;
        const now = new Date().toISOString();
        memories.set(id, {
          id,
          memory: first.content,
          user_id: String(body.user_id ?? ""),
          run_id: String(body.run_id ?? ""),
          metadata: isObject(body.metadata) ? body.metadata : {},
          created_at: now,
          updated_at: now,
        });
        events.set(eventId, { polls: 0, failed: failFollowingEvent });
        failFollowingEvent = false;
        sendJson(res, 200, {
          message: "Memory processing has been queued for background execution",
          status: "PENDING",
          event_id: eventId,
        });
        return;
      }

      const eventMatch = url.pathname.match(/^\/v1\/event\/([^/]+)\/$/);
      if (method === "GET" && eventMatch) {
        const event = events.get(decodeURIComponent(eventMatch[1]));
        if (!event) {
          sendJson(res, 404, { detail: "event not found" });
          return;
        }
        event.polls++;
        const status = event.failed ? "FAILED" : event.polls === 1 ? "PENDING" : "SUCCEEDED";
        sendJson(res, 200, {
          id: eventMatch[1],
          event_type: "ADD",
          status,
          results: [],
          latency: status === "SUCCEEDED" ? 12 : null,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v3/memories/") {
        const body = await readJson(req);
        const results = [...memories.values()].filter((memory) => matchesFilters(memory, body.filters));
        sendJson(res, 200, {
          count: results.length,
          next: null,
          previous: null,
          results,
        });
        return;
      }

      if (method === "POST" && url.pathname === "/v3/memories/search/") {
        if (failingSearches > 0) {
          failingSearches--;
          sendJson(res, 503, { detail: "temporary search failure" });
          return;
        }
        if (searchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, searchDelayMs));
        if (res.destroyed) return;
        const body = await readJson(req);
        const query = String(body.query ?? "");
        const topK = typeof body.top_k === "number" ? body.top_k : 10;
        const results = [...memories.values()]
          .filter((memory) => matchesFilters(memory, body.filters))
          .map((memory) => ({ ...memory, score: overlap(query, memory.memory) }))
          .filter((memory) => memory.score > 0)
          .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
          .slice(0, topK);
        sendJson(res, 200, { results });
        return;
      }

      const memoryMatch = url.pathname.match(/^\/v1\/memories\/([^/]+)\/$/);
      if (memoryMatch) {
        const id = decodeURIComponent(memoryMatch[1]);
        const memory = memories.get(id);
        if (method === "GET") {
          if (!memory) sendJson(res, 404, { detail: "memory not found" });
          else sendJson(res, 200, memory);
          return;
        }
        if (method === "PUT") {
          if (!memory) {
            sendJson(res, 404, { detail: "memory not found" });
            return;
          }
          const body = await readJson(req);
          const updated: StoredMemory = {
            ...memory,
            memory: typeof body.text === "string" ? body.text : memory.memory,
            metadata: isObject(body.metadata) ? body.metadata : memory.metadata,
            updated_at: new Date().toISOString(),
          };
          memories.set(id, updated);
          sendJson(res, 200, { ...updated, text: updated.memory });
          return;
        }
        if (method === "DELETE") {
          if (!memory) {
            sendJson(res, 404, { detail: "memory not found" });
            return;
          }
          memories.delete(id);
          res.writeHead(204);
          res.end();
          return;
        }
      }

      if (method === "DELETE" && url.pathname === "/v1/memories/") {
        cleanupCalls++;
        if (failingCleanups > 0) {
          failingCleanups--;
          sendJson(res, 503, { detail: "temporary cleanup failure" });
          return;
        }
        const runId = url.searchParams.get("run_id");
        if (!runId) {
          sendJson(res, 400, { detail: "run_id required" });
          return;
        }
        for (const [id, memory] of memories) if (memory.run_id === runId) memories.delete(id);
        res.writeHead(204);
        res.end();
        return;
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
  if (!address || typeof address === "string") throw new Error("fake Mem0 server did not bind a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    failNextSearch(count = 1): void {
      failingSearches = count;
    },
    failNextCleanup(count = 1): void {
      failingCleanups = count;
    },
    failNextEvent(): void {
      failFollowingEvent = true;
    },
    setSearchDelay(ms: number): void {
      searchDelayMs = ms;
    },
    snapshot(): FakeMem0Snapshot {
      return {
        memories: memories.size,
        requests: requestCount,
        cleanupCalls,
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
