#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config, embeddingsEnabled, getDb, hasVec, onWrite, runDigest, syncWithPrimary } from "../core/index.js";
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

  if (config.primaryUrls.length > 0) {
    console.log(`[hub] eşitleme: ${config.primaryUrls.join(", ")} ile her ${config.syncIntervalSec}sn (+ yazımda anında push)`);

    // Eşzamanlı sync çalışmasın: devam eden varsa yeni istek kuyruğa alınır (tek pending yeter,
    // üst üste binen istekler tek turda toplanır).
    let syncing = false;
    let pending = false;
    const runSync = async (): Promise<void> => {
      if (syncing) {
        pending = true;
        return;
      }
      syncing = true;
      try {
        const res = await syncWithPrimary(config.primaryUrls, config.primaryToken);
        if (res.ok) {
          const p = res.pulled!, q = res.pushed!;
          const total = p.memories + p.documents + p.projects + p.sessions + p.machines + p.deletions +
                        q.memories + q.documents + q.projects + q.sessions + q.machines + q.deletions;
          if (total > 0) console.log(`[hub] sync (${res.url}): alınan ${JSON.stringify(p)}, gönderilen ${JSON.stringify(q)}`);
        } else {
          // Erişilemezse sessizce devam — local-first, primary dönünce kaldığı yerden sürer.
          console.error(`[hub] sync başarısız (yerel devam ediyor): ${res.error}`);
        }
      } finally {
        syncing = false;
        if (pending) {
          pending = false;
          void runSync();
        }
      }
    };

    void runSync();
    setInterval(runSync, config.syncIntervalSec * 1000);

    // Push-on-write: her yazımdan 5sn sonra (art arda yazımlar tek sync'e toplanır).
    let debounceTimer: NodeJS.Timeout | null = null;
    onWrite(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void runSync();
      }, 5000);
    });
  }

  // Gece özeti: dakikada bir saat kontrolü ile hafif zamanlayıcı (node-cron yok — sıfır bağımlılık).
  // Aynı gün ikinci kez tetiklenmeye karşı runDigest zaten memories'te o günün başlığını kontrol eder.
  setInterval(() => {
    const now = new Date();
    const hh = now.getHours();
    const mm = now.getMinutes();
    if (hh === 3 && mm === 30) {
      runDigest("daily")
        .then((res) => console.log(`[hub] günlük özet: ${JSON.stringify(res)}`))
        .catch((err) => console.error(`[hub] günlük özet hatası: ${(err as Error).message}`));
    } else if (now.getDay() === 1 && hh === 4 && mm === 0) {
      runDigest("weekly")
        .then((res) => console.log(`[hub] haftalık özet: ${JSON.stringify(res)}`))
        .catch((err) => console.error(`[hub] haftalık özet hatası: ${(err as Error).message}`));
    }
  }, 60_000);
});
