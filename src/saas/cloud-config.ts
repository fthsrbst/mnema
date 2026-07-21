import { z } from "zod";
import type { PaddlePriceCatalog } from "./paddle.js";

export interface CloudRuntimeConfig {
  appUrl: string;
  supabaseUrl: string;
  supabasePublicKey: string;
  supabaseServiceRoleKey: string;
  httpsOnly: boolean;
  trustProxyHops: number;
  rateLimitPerMinute: number;
  webhookRateLimitPerMinute: number;
  rateLimitRedisUrl?: string;
  communityApiEnabled?: boolean;
  testSubscriptionsEnabled: boolean;
  paddle: {
    apiKey: string;
    webhookSecret: string;
    environment: "sandbox" | "production";
    approvedCheckoutUrl: string;
    prices: PaddlePriceCatalog;
  } | null;
}

const urlSchema = z.string().url().transform((value) => value.replace(/\/$/, ""));
const redisUrlSchema = z.string().url().refine(
  (value) => ["redis:", "rediss:"].includes(new URL(value).protocol),
  "CLOUD_RATE_LIMIT_REDIS_URL must use redis:// or rediss://"
);

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

/** Returns null when cloud mode is not configured; partial configuration fails closed. */
export function loadCloudRuntimeConfig(env: NodeJS.ProcessEnv = process.env): CloudRuntimeConfig | null {
  const cloudKeys = [
    "CLOUD_APP_URL",
    "CLOUD_HTTPS_ONLY",
    "CLOUD_TRUST_PROXY_HOPS",
    "CLOUD_RATE_LIMIT_PER_MINUTE",
    "CLOUD_WEBHOOK_RATE_LIMIT_PER_MINUTE",
    "CLOUD_RATE_LIMIT_REDIS_URL",
    "CLOUD_ENABLE_COMMUNITY_API",
    "CLOUD_BILLING_ENABLED",
    "CLOUD_ALLOW_TEST_SUBSCRIPTIONS",
    "SUPABASE_URL",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SECRET_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PADDLE_API_KEY",
    "PADDLE_WEBHOOK_SECRET",
    "PADDLE_ENVIRONMENT",
    "PADDLE_APPROVED_CHECKOUT_URL",
    "PADDLE_PRICE_STARTER_MONTHLY",
    "PADDLE_PRICE_STARTER_ANNUAL",
    "PADDLE_PRICE_PRO_MONTHLY",
    "PADDLE_PRICE_PRO_ANNUAL",
    "PADDLE_PRICE_TEAM_MONTHLY",
    "PADDLE_PRICE_TEAM_ANNUAL",
  ];
  if (!cloudKeys.some((key) => env[key]?.trim())) return null;
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required when Mnema Cloud mode is configured`);
    return value;
  };
  const environment = z.enum(["sandbox", "production"]).parse(env.PADDLE_ENVIRONMENT?.trim() || "sandbox");
  const httpsOnly = boolean(env, "CLOUD_HTTPS_ONLY", false);
  const appUrl = urlSchema.parse(required("CLOUD_APP_URL"));
  const rateLimitRedisUrl = env.CLOUD_RATE_LIMIT_REDIS_URL?.trim();
  const paddleKeys = cloudKeys.filter((key) => key.startsWith("PADDLE_"));
  const hasPaddleConfiguration = paddleKeys.some((key) => env[key]?.trim());
  const billingEnabled = boolean(env, "CLOUD_BILLING_ENABLED", hasPaddleConfiguration);
  const testSubscriptionsEnabled = boolean(env, "CLOUD_ALLOW_TEST_SUBSCRIPTIONS", false);
  if (!billingEnabled && hasPaddleConfiguration) {
    throw new Error("Paddle values require CLOUD_BILLING_ENABLED=true (or the flag to be omitted)");
  }
  if (testSubscriptionsEnabled) {
    const hostname = new URL(appUrl).hostname;
    const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
    const bindHost = env.HUB_HOST?.trim() || "127.0.0.1";
    const loopbackBind = bindHost === "127.0.0.1" || bindHost === "localhost" || bindHost === "::1";
    if (env.NODE_ENV === "production" || httpsOnly || !loopback || !loopbackBind || billingEnabled) {
      throw new Error("CLOUD_ALLOW_TEST_SUBSCRIPTIONS is restricted to loopback-bound HTTP previews without Paddle");
    }
  }
  const paddle = billingEnabled
    ? (() => {
        const approvedCheckoutUrl = urlSchema.parse(required("PADDLE_APPROVED_CHECKOUT_URL"));
        if (environment === "production" && (!httpsOnly || !appUrl.startsWith("https://") || !approvedCheckoutUrl.startsWith("https://"))) {
          throw new Error("Paddle production requires CLOUD_HTTPS_ONLY=true and HTTPS app/checkout URLs");
        }
        if (environment === "production" && !rateLimitRedisUrl) {
          throw new Error("Paddle production requires CLOUD_RATE_LIMIT_REDIS_URL for shared abuse control");
        }
        return {
          apiKey: required("PADDLE_API_KEY"),
          webhookSecret: required("PADDLE_WEBHOOK_SECRET"),
          environment,
          approvedCheckoutUrl,
          prices: {
            starter: {
              monthly: required("PADDLE_PRICE_STARTER_MONTHLY"),
              annual: required("PADDLE_PRICE_STARTER_ANNUAL"),
            },
            pro: {
              monthly: required("PADDLE_PRICE_PRO_MONTHLY"),
              annual: required("PADDLE_PRICE_PRO_ANNUAL"),
            },
            team: {
              monthly: required("PADDLE_PRICE_TEAM_MONTHLY"),
              annual: required("PADDLE_PRICE_TEAM_ANNUAL"),
            },
          },
        } satisfies NonNullable<CloudRuntimeConfig["paddle"]>;
      })()
    : null;
  return {
    appUrl,
    supabaseUrl: urlSchema.parse(required("SUPABASE_URL")),
    supabasePublicKey: env.SUPABASE_PUBLISHABLE_KEY?.trim() || required("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: env.SUPABASE_SECRET_KEY?.trim() || required("SUPABASE_SERVICE_ROLE_KEY"),
    httpsOnly,
    trustProxyHops: integer(env, "CLOUD_TRUST_PROXY_HOPS", 0, 0, 5),
    rateLimitPerMinute: integer(env, "CLOUD_RATE_LIMIT_PER_MINUTE", 300, 10, 100_000),
    webhookRateLimitPerMinute: integer(env, "CLOUD_WEBHOOK_RATE_LIMIT_PER_MINUTE", 120, 10, 100_000),
    rateLimitRedisUrl: rateLimitRedisUrl ? redisUrlSchema.parse(rateLimitRedisUrl) : undefined,
    communityApiEnabled: boolean(env, "CLOUD_ENABLE_COMMUNITY_API", false),
    testSubscriptionsEnabled,
    paddle,
  };
}
