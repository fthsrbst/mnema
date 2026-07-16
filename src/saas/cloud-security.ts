import { createHash } from "node:crypto";
import type { Request, RequestHandler } from "express";

export interface CloudSecurityHeadersOptions {
  supabaseUrl?: string;
  httpsOnly?: boolean;
}

/** Browser hardening shared by Community and Cloud without a runtime dependency. */
export function cloudSecurityHeaders(options: CloudSecurityHeadersOptions = {}): RequestHandler {
  const connectSources = ["'self'"];
  if (options.supabaseUrl) {
    const supabase = new URL(options.supabaseUrl);
    connectSources.push(supabase.origin, `wss://${supabase.host}`);
  }
  const csp = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob:",
    `connect-src ${connectSources.join(" ")}`,
    "frame-src https://*.paddle.com https://*.paddle.io",
    "worker-src 'self' blob:",
    ...(options.httpsOnly ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  return (req, res, next) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (options.httpsOnly) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (req.path.startsWith("/cloud/api")) res.setHeader("Cache-Control", "no-store");
    next();
  };
}

export interface CloudRateLimitOptions {
  limit: number;
  windowMs?: number;
  now?: () => number;
  namespace?: string;
  store?: CloudRateLimitStore;
}

export interface CloudRateLimitStore {
  consume(key: string, windowMs: number): Promise<{ count: number; resetAfterMs: number }>;
}

interface RateBucket {
  count: number;
  resetAt: number;
}

function requestIdentity(req: Request): string {
  const authorization = req.header("authorization") ?? "";
  const credential = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const credentialHash = credential
    ? createHash("sha256").update(credential).digest("hex").slice(0, 24)
    : "anonymous";
  return createHash("sha256").update(`${req.ip}\0${credentialHash}`).digest("hex").slice(0, 32);
}

/** Uses a shared store when configured; otherwise remains process-local defense in depth. */
export function createCloudRateLimiter(options: CloudRateLimitOptions): RequestHandler {
  const limit = Math.max(1, Math.trunc(options.limit));
  const windowMs = Math.max(1_000, Math.trunc(options.windowMs ?? 60_000));
  const now = options.now ?? Date.now;
  const buckets = new Map<string, RateBucket>();
  let operations = 0;
  const apply = (
    res: Parameters<RequestHandler>[1],
    next: Parameters<RequestHandler>[2],
    count: number,
    resetAt: number,
    timestamp: number,
    backend: "distributed" | "process"
  ): void => {
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(resetAt / 1_000)));
    res.setHeader("X-RateLimit-Backend", backend);
    if (count > limit) {
      const retryAfter = Math.max(1, Math.ceil((resetAt - timestamp) / 1_000));
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: "rate_limited", retry_after_seconds: retryAfter });
      return;
    }
    next();
  };
  return (req, res, next) => {
    const timestamp = now();
    const key = `${options.namespace ?? "cloud"}:${requestIdentity(req)}`;
    if (options.store) {
      void options.store.consume(key, windowMs).then(({ count, resetAfterMs }) => {
        if (res.headersSent) return;
        apply(res, next, count, timestamp + resetAfterMs, timestamp, "distributed");
      }).catch((error) => {
        console.error(`[hub] Cloud distributed rate limit failed: ${(error as Error).name}`);
        if (res.headersSent) return;
        res.setHeader("Retry-After", "5");
        res.status(503).json({ error: "rate_limit_unavailable" });
      });
      return;
    }
    const existing = buckets.get(key);
    const bucket = !existing || existing.resetAt <= timestamp
      ? { count: 0, resetAt: timestamp + windowMs }
      : existing;
    bucket.count += 1;
    buckets.set(key, bucket);
    operations += 1;
    if (operations % 1_000 === 0) {
      for (const [candidate, value] of buckets) if (value.resetAt <= timestamp) buckets.delete(candidate);
    }
    apply(res, next, bucket.count, bucket.resetAt, timestamp, "process");
  };
}
