#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  config,
  assertDeploymentSafety,
  embeddingsDisabledReason,
  embeddingsEnabled,
  getDb,
  hasVec,
  onWrite,
  recordAuditEvent,
  runDigest,
  syncWithPrimary,
  vecError,
} from "../core/index.js";
import { buildMcpServer } from "./mcp.js";
import { buildRestRouter } from "./rest.js";
import {
  authenticate,
  authenticationEnabled,
  authorizeMcp,
  consumeRateLimit,
  hasProjectAccess,
  hasScope,
  requestProject,
  restScope,
  type Principal,
} from "./auth.js";

const app = express();
assertDeploymentSafety();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  // Auth'suz uç: ham hata mesajları (dosya yolu içerebilir) sızdırılmaz — sadece sabit kodlar.
  // Detaylı neden auth'lu /api/rag/stats içinde (degraded_detail).
  const vec_error = vecError() ? "vec_load_failed" : undefined;
  const embeddings_reason = embeddingsDisabledReason() ? "embeddings_disabled" : undefined;
  const degraded = vec_error || embeddings_reason ? { vec_error, embeddings_reason } : null;
  res.json({
    ok: true,
    vec: hasVec(),
    embeddings: embeddingsEnabled(),
    version: "0.1.0",
    deployment_profile: config.deploymentProfile,
    vector_backend: config.vectorBackend,
    degraded,
  });
});

// UI kabuğu (web/dist) bilinçli olarak auth'suz: sadece uygulama kodu içerir, veri içermez —
// veri her zaman /api üzerinden ve token'lıdır. /outputs ise üretilen medya (kullanıcı verisi)
// içerdiğinden auth'un ARKASINDA servis edilir (aşağıda) — Funnel açıkken internete sızmasın.
app.use("/", express.static("./web/dist"));

// Bearer/scoped-token auth (health and static UI shell excluded).
// ?token= desteği: claude.ai/ChatGPT/Gemini connector'ları özel header koyamıyor —
// token URL'de taşınır (https zorunlu, Funnel/Serve bunu sağlar).
app.use((req, res, next) => {
  const header = req.headers.authorization ?? "";
  const headerToken = header.startsWith("Bearer ") ? header.slice(7) : null;
  const queryToken = config.allowQueryToken && typeof req.query.token === "string" ? req.query.token : null;
  const principal = authenticate(headerToken ?? queryToken);
  if (!principal) {
    const anonymousRate = consumeRateLimit("anonymous");
    const requestId = randomUUID();
    res.setHeader("X-Request-Id", requestId);
    if (!anonymousRate.allowed) {
      res.setHeader("Retry-After", String(anonymousRate.retryAfterSec));
      return void res.status(429).json({ error: "rate_limited", retry_after_seconds: anonymousRate.retryAfterSec });
    }
    try {
      recordAuditEvent({
        request_id: requestId,
        actor: "anonymous",
        action: "authentication_denied",
        resource: req.path,
        status: 401,
        metadata: { method: req.method },
      });
    } catch (err) {
      console.error(`[hub] audit write failed: ${(err as Error).message}`);
    }
    return void res.status(401).json({ error: "unauthorized" });
  }
  if (queryToken) res.setHeader("X-Hub-Token-Transport", "query-parameter-deprecated");
  res.locals.principal = principal;
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  const action = (() => {
    if (req.path !== "/mcp") return `${req.method} ${req.path}`;
    const messages = Array.isArray(req.body) ? req.body : [req.body];
    const tools = messages
      .map((message) => message?.params?.name)
      .filter((name): name is string => typeof name === "string")
      .slice(0, 20);
    return tools.length > 0 ? `mcp:${tools.join(",")}` : "mcp:protocol";
  })();
  const auditProject = requestProject(req) ?? null;
  res.on("finish", () => {
    try {
      recordAuditEvent({
        request_id: requestId,
        actor: principal.id,
        action,
        resource: req.path,
        project: auditProject,
        status: res.statusCode,
        metadata: { method: req.method, auth_mode: principal.auth_mode },
      });
    } catch (err) {
      console.error(`[hub] audit write failed: ${(err as Error).message}`);
    }
  });
  next();
});

app.use((_req, res, next) => {
  const principal = res.locals.principal as Principal;
  const rate = consumeRateLimit(principal.id);
  res.setHeader("X-RateLimit-Limit", String(Math.max(1, Math.trunc(config.rateLimitPerMinute))));
  if (!rate.allowed) {
    res.setHeader("Retry-After", String(rate.retryAfterSec));
    return void res.status(429).json({ error: "rate_limited", retry_after_seconds: rate.retryAfterSec });
  }
  next();
});

// Üretilen medya: auth middleware'inden sonra — tarayıcı/istemci ?token= ile erişir.
app.use("/outputs", (_req, res, next) => {
  const principal = res.locals.principal as Principal;
  if (!hasScope(principal, "knowledge:read")) return void res.status(403).json({ error: "forbidden" });
  next();
});
app.use("/outputs", express.static("./data/outputs"));

app.use("/api", (req, res, next) => {
  const principal = res.locals.principal as Principal;
  const required = restScope(req.method, req.path);
  if (!hasScope(principal, required)) {
    return void res.status(403).json({ error: "forbidden", required_scope: required });
  }
  const project = requestProject(req);
  const restricted = !principal.projects.includes("*");
  const requiresExplicitProject =
    req.path === "/context" ||
    req.path === "/timeline" ||
    req.path.startsWith("/memory") ||
    req.path.startsWith("/rag/search") ||
    req.path === "/rag/documents" ||
    req.path.startsWith("/sessions") ||
    req.path.startsWith("/graph");
  if (restricted && requiresExplicitProject && project === undefined) {
    return void res.status(403).json({ error: "forbidden", reason: "explicit project required for this principal" });
  }
  if (project !== undefined && !hasProjectAccess(principal, project)) {
    return void res.status(403).json({ error: "forbidden", reason: "project access denied" });
  }
  next();
});
app.use("/api", buildRestRouter());

// MCP: stateless Streamable HTTP — her istek için taze server+transport
app.post("/mcp", async (req, res) => {
  try {
    const principal = res.locals.principal as Principal;
    const authz = authorizeMcp(principal, req.body);
    if (!authz.ok) {
      return void res.status(403).json({
        jsonrpc: "2.0",
        error: { code: -32003, message: "Forbidden", data: { reason: authz.reason } },
        id: (req.body as { id?: unknown })?.id ?? null,
      });
    }
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
  console.log(`[hub] deployment profile: ${config.deploymentProfile}, vector backend: ${config.vectorBackend}`);
  console.log(`[hub] vektör arama: ${hasVec() ? "açık" : "KAPALI"}, embedding: ${embeddingsEnabled() ? "Gemini" : "YOK (FTS-only)"}, auth: ${authenticationEnabled() ? "açık" : "KAPALI (local-dev)"}`);

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
          const total = p.memories + p.documents + (p.relations ?? 0) + p.projects + p.sessions + p.machines + p.deletions +
                        q.memories + q.documents + (q.relations ?? 0) + q.projects + q.sessions + q.machines + q.deletions;
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
