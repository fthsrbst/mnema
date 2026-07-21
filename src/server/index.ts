#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  config,
  assertDeploymentSafety,
  embeddingsDisabledReason,
  embeddingsEnabled,
  flushVectorOutbox,
  ensureVectorProjectionQueued,
  getDb,
  hasVec,
  onWrite,
  pruneStalePresence,
  recordAuditEvent,
  runDigest,
  seedAssetsFromDisk,
  syncWithPrimary,
  vectorStore,
  vecError,
  // Agent Intelligence Platform
  startWorker,
  registerJobHandler,
  initWebhookDelivery,
  runHygiene,
  compactSessions,
  distillProject,
  pruneOldTasks,
  pruneOldMessages,
  pruneOfflineAgents,
  pruneOldAgents,
  pruneEvents,
  pruneJobs,
  recordRequest,
  backfillMissingEmbeddings,
  runConsistencyCheck,
} from "../core/index.js";
import { buildMcpServer } from "./mcp.js";
import { buildRestRouter } from "./rest.js";
import {
  buildCloudAccountRouter,
  buildCloudWebhookRouter,
  cloudSecurityHeaders,
  connectCloudRateLimitStore,
  createCloudRateLimiter,
  loadCloudRuntimeConfig,
  purgeDueOrganizations,
} from "../saas/index.js";
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
app.disable("x-powered-by");
assertDeploymentSafety();
const cloudConfig = loadCloudRuntimeConfig();
const communityEnabled = !cloudConfig || Boolean(cloudConfig.communityApiEnabled);
const webDistDir = resolve(process.env.MNEMA_WEB_DIST_DIR?.trim() || "./web/dist");
if (cloudConfig?.communityApiEnabled && !authenticationEnabled()) {
  throw new Error("CLOUD_ENABLE_COMMUNITY_API=true requires scoped Community authentication");
}
const cloudRateLimitConnection = cloudConfig?.rateLimitRedisUrl
  ? await connectCloudRateLimitStore(cloudConfig.rateLimitRedisUrl)
  : null;
if (cloudConfig?.trustProxyHops) app.set("trust proxy", cloudConfig.trustProxyHops);
app.use(cloudSecurityHeaders({ supabaseUrl: cloudConfig?.supabaseUrl, httpsOnly: cloudConfig?.httpsOnly }));
if (cloudConfig?.paddle) {
  // Paddle signature verification requires the exact raw bytes. This route is
  // intentionally mounted before the global JSON parser and self-host auth.
  app.use(
    "/cloud/api/billing/webhook",
    createCloudRateLimiter({
      limit: cloudConfig.webhookRateLimitPerMinute,
      namespace: "cloud-webhook",
      store: cloudRateLimitConnection?.store,
    }),
    express.raw({ type: "application/json", limit: "1mb" }),
    buildCloudWebhookRouter(cloudConfig)
  );
}
app.use(express.json({ limit: "10mb" }));

if (cloudConfig) {
  app.use(
    "/cloud/api",
    createCloudRateLimiter({
      limit: cloudConfig.rateLimitPerMinute,
      namespace: "cloud-api",
      store: cloudRateLimitConnection?.store,
    }),
    buildCloudAccountRouter(cloudConfig)
  );
}

app.get("/health", (_req, res) => {
  // Auth'suz uç: ham hata mesajları (dosya yolu içerebilir) sızdırılmaz — sadece sabit kodlar.
  // Detaylı neden auth'lu /api/rag/stats içinde (degraded_detail).
  const vec_error = communityEnabled && vecError() ? "vec_load_failed" : undefined;
  const embeddings_reason = communityEnabled && embeddingsDisabledReason() ? "embeddings_disabled" : undefined;
  const degraded = vec_error || embeddings_reason ? { vec_error, embeddings_reason } : null;
  res.json({
    ok: true,
    vec: communityEnabled ? hasVec() : false,
    embeddings: communityEnabled ? embeddingsEnabled() : false,
    version: "0.1.0",
    deployment_profile: config.deploymentProfile,
    community: communityEnabled ? "enabled" : "disabled",
    vector_backend: communityEnabled ? config.vectorBackend : null,
    vector_projection: communityEnabled ? vectorStore.status() : null,
    cloud: cloudConfig ? "configured" : "disabled",
    cloud_billing: cloudConfig ? (cloudConfig.paddle ? "configured" : "disabled") : "disabled",
    cloud_rate_limit: cloudConfig
      ? (cloudRateLimitConnection ? "distributed" : "process")
      : "disabled",
    degraded,
  });
});

// UI kabuğu (web/dist) bilinçli olarak auth'suz: sadece uygulama kodu içerir, veri içermez —
// veri her zaman /api üzerinden ve token'lıdır. /outputs ise üretilen medya (kullanıcı verisi)
// içerdiğinden auth'un ARKASINDA servis edilir (aşağıda) — Funnel açıkken internete sızmasın.
app.use("/", express.static(webDistDir));

// Hosted Cloud defaults to a Cloud-only public surface. Paddle return URLs and
// auth redirects still receive the SPA shell, while Community REST/MCP remain
// unreachable unless an operator explicitly enables and authenticates them.
app.get("*", (req, res, next) => {
  const acceptsHtml = (req.header("accept") ?? "").includes("text/html");
  if (!cloudConfig || communityEnabled || req.path.startsWith("/cloud/api") || !acceptsHtml) return next();
  res.sendFile(resolve(webDistDir, "index.html"));
});
app.use((_req, res, next) => {
  if (!communityEnabled) return void res.status(404).json({ error: "community_api_disabled" });
  next();
});

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

// İstek metrikleri: /health ve statik dosyalardan sonra, gerçek API/MCP trafiğinden önce.
// res.on("finish") ile ölçüm, response tamamlanmadan sayılmaz (timeout/abort'ta hiç sayılmaz).
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    recordRequest(req.method, req.path, res.statusCode, durationMs);
  });
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
    req.path === "/agents/active" ||
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

if (communityEnabled) {
  getDb(); // şemayı baştan kur, sorun varsa açılışta patlasın
  // Skill/prompt DB authority: ilk açılışta repo dosyalarını seed eder (idempotent —
  // zaten DB'de olanın üzerine yazmaz). Sonraki yazımlar DB'de kalır, sync ile yayılır.
  const seeded = seedAssetsFromDisk();
  if (seeded.seeded > 0) console.log(`[hub] assets seed: ${seeded.seeded} skill/prompt disk'ten DB'ye içe aktarıldı`);
  pruneStalePresence();
}

app.listen(config.port, config.host, () => {
  console.log(`[hub] http://${config.host}:${config.port}  (MCP: /mcp, REST: /api, health: /health)`);
  if (communityEnabled) {
    console.log(`[hub] deployment profile: ${config.deploymentProfile}, vector backend: ${config.vectorBackend}`);
    console.log(`[hub] vektör arama: ${hasVec() ? "açık" : "KAPALI"}, embedding: ${embeddingsEnabled() ? "Gemini" : "YOK (FTS-only)"}, auth: ${authenticationEnabled() ? "açık" : "KAPALI (local-dev)"}`);
  } else {
    console.log(`[hub] hosted Cloud-only profile, shared rate limit: ${cloudRateLimitConnection ? "ready" : "not configured (sandbox only)"}`);
  }

  if (cloudConfig) {
    let purgingOrganizations = false;
    const purgeOrganizations = async (): Promise<void> => {
      if (purgingOrganizations) return;
      purgingOrganizations = true;
      try {
        const result = await purgeDueOrganizations(cloudConfig);
        if (result.examined > 0) {
          console.log(`[hub] Cloud lifecycle: purged=${result.purged}, waiting_for_billing=${result.waitingForBilling}`);
        }
      } catch (error) {
        console.error(`[hub] Cloud lifecycle purge failed: ${(error as Error).name}`);
      } finally {
        purgingOrganizations = false;
      }
    };
    void purgeOrganizations();
    setInterval(purgeOrganizations, 60 * 60 * 1_000);
  }

  if (communityEnabled && config.vectorBackend === "qdrant") {
    const initialProjection = ensureVectorProjectionQueued();
    if (initialProjection.queued) {
      console.log(`[hub] Qdrant full projection queued: memories=${initialProjection.memories}, chunks=${initialProjection.chunks}`);
    }
    let flushingVectors = false;
    const flushVectors = async (): Promise<void> => {
      if (flushingVectors) return;
      flushingVectors = true;
      try {
        const result = await flushVectorOutbox();
        if (result.processed > 0 || result.failed > 0 || result.discarded > 0) {
          console.log(`[hub] Qdrant projection: processed=${result.processed}, failed=${result.failed}, discarded_stale_generation=${result.discarded}`);
        }
      } catch (err) {
        console.error(`[hub] Qdrant projection flush failed: ${(err as Error).message}`);
      } finally {
        flushingVectors = false;
      }
    };
    void flushVectors();
    setInterval(flushVectors, config.qdrantFlushIntervalMs);
    onWrite(() => void flushVectors());
  }

  if (communityEnabled && config.primaryUrls.length > 0) {
    console.log(
      `[hub] eşitleme: ${config.primaryUrls.join(", ")} ile her ${config.syncIntervalSec}sn ` +
      `(+ yazımdan ${config.syncDebounceMs}ms sonra push)`
    );

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
        // Presence prune sync'ten önce: 7+ günlük done/abandoned kayıtlar tombstone'lanır,
        // böylece bu turda gönderilecek silme kümesine de girerler. Ayrı bir bakım
        // noktası yok; ucuz olduğu için sync öncesi burada yeterli.
        pruneStalePresence();
        const res = await syncWithPrimary(config.primaryUrls, config.primaryToken);
        if (res.ok) {
          const p = res.pulled!, q = res.pushed!;
          const total = p.memories + p.documents + (p.relations ?? 0) + p.projects + p.sessions + p.machines + (p.assets ?? 0) + (p.agent_presence ?? 0) + p.deletions +
                        q.memories + q.documents + (q.relations ?? 0) + q.projects + q.sessions + q.machines + (q.assets ?? 0) + (q.agent_presence ?? 0) + q.deletions;
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

    // Push-on-write: kısa debounce, art arda yazımları tek sync'e toplar.
    let debounceTimer: NodeJS.Timeout | null = null;
    onWrite(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void runSync();
      }, config.syncDebounceMs);
    });
  }

  // Primary yoksa (tek-node kurulum) presence prune sync döngüsüne binmez —
  // bağımsız düşük frekanslı bir zamanlayıcı yeterli (ucuz, günde birkaç kez de olsa sorun değil).
  if (communityEnabled && config.primaryUrls.length === 0) {
    setInterval(() => pruneStalePresence(), 6 * 60 * 60 * 1_000);
  }

  // Embedding backfill, startup'ta bir kez: kayıt sırasında embedding başarısız olmuş
  // memory/chunk'ları (Gemini hatası/ağ kesintisi) tamamlar. Eksik yoksa no-op.
  if (communityEnabled) {
    void backfillMissingEmbeddings()
      .then((r) => {
        if (r.memories_embedded > 0 || r.chunks_embedded > 0) {
          console.log(`[hub] başlangıç backfill: memories=${r.memories_embedded}, chunks=${r.chunks_embedded}`);
        }
      })
      .catch((err) => console.error(`[hub] başlangıç backfill hatası: ${(err as Error).message}`));
  }

  if (communityEnabled) {
    // Agent Intelligence Platform: async job worker. Handlers stay thin — they just
    // call the real domain functions; queuing/retry/backoff logic lives in worker.ts.
    registerJobHandler("hygiene", async (payload) => runHygiene(payload.project as string | undefined));
    registerJobHandler("compact", async (payload) =>
      compactSessions(payload.project as string, payload.opts as { count?: number; archiveOld?: boolean } | undefined)
    );
    registerJobHandler("distill", async (payload) => distillProject(payload.project as string));
    registerJobHandler("webhook_test", async () => ({ ok: true }));
    // Embedding backfill job handler: enqueue edilen 'embed' job'ları worker.ts'teki
    // sıra + exponential backoff çerçevesinde işlenir. Startup ve periyodik bakım
    // döngüsü backfillMissingEmbeddings()'i doğrudan çağırır (kuyruk birikimi olmadan);
    // elle tetikleme bu handler üzerinden mümkün (hub job enqueue embed).
    registerJobHandler("embed", async (payload) =>
      backfillMissingEmbeddings((payload.limit as number | undefined) ?? 100)
    );
    startWorker(config.workerIntervalMs);

    // Outbound webhook delivery: subscribes to the typed hub event bus.
    initWebhookDelivery();

    // Agent Intelligence Platform maintenance: same 6h cadence as the presence prune
    // above — cheap, low-frequency housekeeping, no dedicated scheduler needed.
    setInterval(() => {
      try {
        pruneOldTasks();
        pruneOldMessages();
        pruneOfflineAgents();
        pruneOldAgents();
        pruneEvents();
        pruneJobs();
      } catch (err) {
        console.error(`[hub] agent intelligence prune hatası: ${(err as Error).message}`);
      }
      // Embedding backfill: kayıt anında embed edilemeyen memory/chunk'ları (Gemini
      // hatası/ağ kesintisi) tamamlar. Eksik yoksa no-op; hata olursa bir sonraki
      // tur tekrar dener. Worker (reindex job) ile aynı tabloları paylaşır — çakışma
      // değil: ikisi de idempotent DELETE+INSERT (en son yazan kazanır).
      void backfillMissingEmbeddings()
        .then((r) => {
          if (r.memories_embedded > 0 || r.chunks_embedded > 0) {
            console.log(`[hub] backfill: memories=${r.memories_embedded}, chunks=${r.chunks_embedded}`);
          }
        })
        .catch((err) => console.error(`[hub] backfill hatası: ${(err as Error).message}`));
    }, 6 * 60 * 60 * 1_000);
  }

  // Gece özeti: dakikada bir saat kontrolü ile hafif zamanlayıcı (node-cron yok — sıfır bağımlılık).
  // Aynı gün ikinci kez tetiklenmeye karşı runDigest zaten memories'te o günün başlığını kontrol eder.
  // Günlük tutarlılık turu (ADR-005): silme invaryantı uzlaştırması + primary ile digest
  // karşılaştırması. Sync turu içindeki kontrol yalnız sync çalıştığında devreye girer;
  // primary erişilemezse veya cihaz uzun süre kapalı kalırsa ıraksama fark edilmezdi.
  // Asla throw etmez — bu bir uyarı kanalı, kapı değil.
  if (communityEnabled) setInterval(() => {
    const now = new Date();
    if (now.getHours() === 4 && now.getMinutes() === 15) {
      runConsistencyCheck(config.primaryUrls, config.primaryToken)
        .then((res) => {
          if (res.divergence) console.warn(`[hub] IRAKSAMA: ${res.divergence.join("; ")}`);
          if (res.deletes.missing_tombstone > 0) {
            console.warn(`[hub] tombstone'suz silme: ${res.deletes.missing_tombstone} kayıt`);
          }
        })
        .catch((err) => console.error(`[hub] tutarlılık kontrolü: ${(err as Error).message}`));
    }
  }, 60_000);

  if (communityEnabled) setInterval(() => {
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
