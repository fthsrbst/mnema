import { z } from "zod";
import type { PaddlePriceCatalog } from "./paddle.js";

export interface CloudRuntimeConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  paddle: {
    apiKey: string;
    webhookSecret: string;
    environment: "sandbox" | "production";
    approvedCheckoutUrl: string;
    prices: PaddlePriceCatalog;
  };
}

const urlSchema = z.string().url().transform((value) => value.replace(/\/$/, ""));

/** Returns null when cloud mode is not configured; partial configuration fails closed. */
export function loadCloudRuntimeConfig(env: NodeJS.ProcessEnv = process.env): CloudRuntimeConfig | null {
  const cloudKeys = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "PADDLE_API_KEY",
    "PADDLE_WEBHOOK_SECRET",
  ];
  if (!cloudKeys.some((key) => env[key]?.trim())) return null;
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required when Mnema Cloud mode is configured`);
    return value;
  };
  const environment = env.PADDLE_ENVIRONMENT === "production" ? "production" : "sandbox";
  return {
    supabaseUrl: urlSchema.parse(required("SUPABASE_URL")),
    supabaseAnonKey: required("SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
    paddle: {
      apiKey: required("PADDLE_API_KEY"),
      webhookSecret: required("PADDLE_WEBHOOK_SECRET"),
      environment,
      approvedCheckoutUrl: urlSchema.parse(required("PADDLE_APPROVED_CHECKOUT_URL")),
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
    },
  };
}
