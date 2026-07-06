#!/usr/bin/env node
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, embeddingsEnabled, getDb, hasVec } from "../core/index.js";
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

// Bearer token auth (health hariç). Token boşsa auth kapalı (lokal dev).
app.use((req, res, next) => {
  if (!config.token) return next();
  const header = req.headers.authorization ?? "";
  if (header === `Bearer ${config.token}`) return next();
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
});
