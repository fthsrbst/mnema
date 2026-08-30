import { randomUUID } from "node:crypto";
import http from "node:http";

interface StoredPassage {
  id: string;
  text: string;
  tags: string[];
  created_at: string;
}

interface StoredAgent {
  id: string;
  name: string;
  description: string;
  model: string;
  embedding: string;
  agent_type: string;
  tags: string[];
  metadata: Record<string, unknown>;
  passages: Map<string, StoredPassage>;
}

export interface FakeLettaSnapshot {
  agents: number;
  passages: number;
  requests: number;
  agentDeleteCalls: number;
  passageCreates: number;
  passageDeletes: number;
  authFailures: number;
}

export interface FakeLettaServer {
  baseUrl: string;
  failNextSearch(count?: number): void;
  failNextAgentDelete(count?: number): void;
  setSearchDelay(ms: number): void;
  snapshot(): FakeLettaSnapshot;
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

function stringList(value: unknown): string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[])
    : [];
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

function passageCount(agents: Map<string, StoredAgent>): number {
  let count = 0;
  for (const agent of agents.values()) count += agent.passages.size;
  return count;
}

export async function startFakeLettaServer(apiKey = "test-key"): Promise<FakeLettaServer> {
  const agents = new Map<string, StoredAgent>();
  let requestCount = 0;
  let agentDeleteCalls = 0;
  let passageCreates = 0;
  let passageDeletes = 0;
  let authFailures = 0;
  let failingSearches = 0;
  let failingAgentDeletes = 0;
  let searchDelayMs = 0;

  const server = http.createServer(async (req, res) => {
    requestCount++;
    try {
      if (req.headers.authorization !== `Bearer ${apiKey}`) {
        authFailures++;
        sendJson(res, 401, { detail: "invalid token" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const method = req.method ?? "GET";

      if (url.pathname === "/v1/agents/" && method === "GET") {
        const requiredTags = url.searchParams.getAll("tags");
        const name = url.searchParams.get("name");
        const after = url.searchParams.get("after");
        const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
        const rows = [...agents.values()]
          .filter((agent) => name === null || agent.name === name)
          .filter((agent) => requiredTags.every((tag) => agent.tags.includes(tag)))
          .sort((a, b) => a.id.localeCompare(b.id));
        const start = after === null ? 0 : Math.max(0, rows.findIndex((agent) => agent.id === after) + 1);
        sendJson(
          res,
          200,
          rows.slice(start, start + limit).map(({ passages: _passages, ...agent }) => agent)
        );
        return;
      }

      if (url.pathname === "/v1/agents/" && method === "POST") {
        const body = await readJson(req);
        if (
          typeof body.name !== "string" ||
          typeof body.model !== "string" ||
          typeof body.embedding !== "string"
        ) {
          sendJson(res, 400, { detail: "name, model, and embedding are required" });
          return;
        }
        const id = `agent-${randomUUID()}`;
        const agent: StoredAgent = {
          id,
          name: body.name,
          description: typeof body.description === "string" ? body.description : "",
          model: body.model,
          embedding: body.embedding,
          agent_type: typeof body.agent_type === "string" ? body.agent_type : "letta_v1_agent",
          tags: stringList(body.tags),
          metadata: isObject(body.metadata) ? body.metadata : {},
          passages: new Map(),
        };
        agents.set(id, agent);
        const { passages: _passages, ...response } = agent;
        sendJson(res, 201, response);
        return;
      }

      if (method === "POST" && url.pathname === "/v1/passages/search") {
        if (failingSearches > 0) {
          failingSearches--;
          sendJson(res, 503, { detail: "temporary search failure" });
          return;
        }
        if (searchDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, searchDelayMs));
        if (res.destroyed) return;
        const body = await readJson(req);
        const agent =
          typeof body.agent_id === "string"
            ? agents.get(body.agent_id)
            : undefined;
        if (!agent) {
          sendJson(res, 404, { detail: "agent not found" });
          return;
        }
        const query = typeof body.query === "string" ? body.query : "";
        const limit =
          typeof body.limit === "number"
            ? Math.min(100, body.limit)
            : 10;
        const requiredTags = stringList(body.tags);
        const matchAll = body.tag_match_mode === "all";
        const results = [...agent.passages.values()]
          .filter((passage) =>
            matchAll
              ? requiredTags.every((tag) => passage.tags.includes(tag))
              : requiredTags.length === 0 ||
                requiredTags.some((tag) => passage.tags.includes(tag))
          )
          .map((passage) => ({ passage, score: overlap(query, passage.text) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score || a.passage.id.localeCompare(b.passage.id))
          .slice(0, limit)
          .map(({ passage, score }) => ({
            passage: {
              id: passage.id,
              text: passage.text,
              created_at: passage.created_at,
              tags: passage.tags,
            },
            score,
            metadata: {},
          }));
        sendJson(res, 200, results);
        return;
      }

      const passagesMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/archival-memory$/);
      if (passagesMatch) {
        const agent = agents.get(decodeURIComponent(passagesMatch[1]));
        if (!agent) {
          sendJson(res, 404, { detail: "agent not found" });
          return;
        }
        if (method === "POST") {
          const body = await readJson(req);
          if (typeof body.text !== "string" || body.text.trim() === "") {
            sendJson(res, 400, { detail: "text is required" });
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
          const passage: StoredPassage = {
            id: `passage-${randomUUID()}`,
            text: body.text,
            tags: stringList(body.tags),
            created_at:
              typeof body.created_at === "string" ? body.created_at : new Date().toISOString(),
          };
          passageCreates++;
          agent.passages.set(passage.id, passage);
          sendJson(res, 201, [passage]);
          return;
        }
        if (method === "GET") {
          const after = url.searchParams.get("after");
          const limit = Math.min(200, Number(url.searchParams.get("limit") ?? 50));
          const rows = [...agent.passages.values()].sort((a, b) => a.id.localeCompare(b.id));
          const start =
            after === null ? 0 : Math.max(0, rows.findIndex((passage) => passage.id === after) + 1);
          sendJson(res, 200, rows.slice(start, start + limit));
          return;
        }
      }

      const passageMatch = url.pathname.match(
        /^\/v1\/agents\/([^/]+)\/archival-memory\/([^/]+)$/
      );
      if (method === "DELETE" && passageMatch) {
        const agent = agents.get(decodeURIComponent(passageMatch[1]));
        if (!agent) {
          sendJson(res, 404, { detail: "agent not found" });
          return;
        }
        const passageId = decodeURIComponent(passageMatch[2]);
        if (!agent.passages.has(passageId)) {
          sendJson(res, 404, { detail: "passage not found" });
          return;
        }
        passageDeletes++;
        agent.passages.delete(passageId);
        sendJson(res, 200, {});
        return;
      }

      const agentMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)$/);
      if (agentMatch) {
        const id = decodeURIComponent(agentMatch[1]);
        const agent = agents.get(id);
        if (method === "GET") {
          if (!agent) {
            sendJson(res, 404, { detail: "agent not found" });
          } else {
            const { passages: _passages, ...response } = agent;
            sendJson(res, 200, response);
          }
          return;
        }
        if (method === "DELETE") {
          agentDeleteCalls++;
          if (failingAgentDeletes > 0) {
            failingAgentDeletes--;
            sendJson(res, 503, { detail: "temporary agent cleanup failure" });
            return;
          }
          if (!agent) {
            sendJson(res, 404, { detail: "agent not found" });
            return;
          }
          agents.delete(id);
          sendJson(res, 200, {});
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
  if (!address || typeof address === "string") throw new Error("fake Letta server did not bind a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    failNextSearch(count = 1): void {
      failingSearches = count;
    },
    failNextAgentDelete(count = 1): void {
      failingAgentDeletes = count;
    },
    setSearchDelay(ms: number): void {
      searchDelayMs = ms;
    },
    snapshot(): FakeLettaSnapshot {
      return {
        agents: agents.size,
        passages: passageCount(agents),
        requests: requestCount,
        agentDeleteCalls,
        passageCreates,
        passageDeletes,
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
