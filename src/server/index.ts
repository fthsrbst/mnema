#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, embeddingsEnabled, getDb, hasVec, syncWithPrimary } from "../core/index.js";
import { buildMcpServer } from "./mcp.js";
import { buildRestRouter } from "./rest.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    vec: hasVec(),
    embeddings: embeddingsEnabled(),
    version: "0.1.0",
  });
});

// Statik içerik auth'suz servis edilir (UI kabuğu + üretilen medya);
// veri her zaman /api üzerinden ve token'lıdır.
app.use("/outputs", express.static("./data/outputs"));
app.use("/", express.static("./web/dist"));

// Bearer token auth (health hariç). Token boşsa auth kapalı (lokal dev).
// ?token= desteği: claude.ai/ChatGPT/Gemini connector'ları özel header koyamıyor —
// token URL'de taşınır (https zorunlu, Funnel/Serve bunu sağlar).
const tokenMatches = (candidate: string): boolean => {
  const a = Buffer.from(candidate);
  const b = Buffer.from(config.token);
  return a.length === b.length && timingSafeEqual(a, b); // zamanlama sızıntısına karşı
};
app.use((req, res, next) => {
  if (!config.token) return next();
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Bearer ") && tokenMatches(header.slice(7))) return next();
  if (typeof req.query.token === "string" && tokenMatches(req.query.token)) return next();
  res.status(401).json({ error: "unauthorized" });
});

app.use("/api", buildRestRouter());

// MCP: stateless Streamable HTTP — her istek için taze server+transport
app.post("/mcp", async (req, res) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[hub] MCP hatası:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

const reject = (res: express.Response) =>
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless mode)" },
    id: null,
  });
app.get("/mcp", (_req, res) => reject(res));
app.delete("/mcp", (_req, res) => reject(res));

getDb(); // şemayı baştan kur, sorun varsa açılışta patlasın

app.listen(config.port, config.host, () => {
  console.log(`[hub] http://${config.host}:${config.port}  (MCP: /mcp, REST: /api, health: /health)`);
  console.log(`[hub] vektör arama: ${hasVec() ? "açık" : "KAPALI"}, embedding: ${embeddingsEnabled() ? "Gemini" : "YOK (FTS-only)"}, auth: ${config.token ? "açık" : "KAPALI"}`);
  if (config.primaryUrl) {
    console.log(`[hub] eşitleme: ${config.primaryUrl} ile her ${config.syncIntervalSec}sn`);
    const runSync = async () => {
      const res = await syncWithPrimary(config.primaryUrl, config.primaryToken);
      if (res.ok) {
        const p = res.pulled!, q = res.pushed!;
        const total = p.memories + p.documents + p.projects + p.sessions + p.machines + p.deletions +
                      q.memories + q.documents + q.projects + q.sessions + q.machines + q.deletions;
        if (total > 0) console.log(`[hub] sync: alınan ${JSON.stringify(p)}, gönderilen ${JSON.stringify(q)}`);
      }
      // Erişilemezse sessiz — local-first, primary dönünce kaldığı yerden devam eder
    };
    runSync();
    setInterval(runSync, config.syncIntervalSec * 1000);
  }
});
