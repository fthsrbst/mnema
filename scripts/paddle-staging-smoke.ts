import { randomUUID } from "node:crypto";
import { createPaddleCheckout, type PaddlePriceCatalog } from "../src/saas/index.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
if (process.env.CLOUD_STAGING_CONFIRM !== "mnema-staging") {
  throw new Error("Set CLOUD_STAGING_CONFIRM=mnema-staging to create one Paddle sandbox transaction");
}
if ((process.env.PADDLE_ENVIRONMENT ?? "sandbox") !== "sandbox") {
  throw new Error("The staging smoke refuses to run against Paddle production");
}

const apiKey = required("PADDLE_API_KEY");
const prices: PaddlePriceCatalog = {
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
};
const paddleHeaders = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
const priceIds = [
  prices.starter.monthly,
  prices.starter.annual,
  prices.pro.monthly,
  prices.pro.annual,
  prices.team.monthly,
  prices.team.annual,
];
for (const priceId of priceIds) {
  const response = await fetch(`https://sandbox-api.paddle.com/prices/${encodeURIComponent(priceId)}`, {
    headers: paddleHeaders,
  });
  if (!response.ok) throw new Error(`Paddle sandbox price validation failed (${response.status})`);
  const payload = await response.json() as { data?: { id?: string; status?: string } };
  if (payload.data?.id !== priceId || payload.data.status !== "active") {
    throw new Error("Paddle sandbox catalog contains a missing or inactive price");
  }
}

const checkout = await createPaddleCheckout({
  apiKey,
  environment: "sandbox",
  approvedCheckoutUrl: required("PADDLE_APPROVED_CHECKOUT_URL"),
  prices,
}, {
  organizationId: randomUUID(),
  userId: randomUUID(),
  plan: "starter",
  interval: "monthly",
});
if (!checkout.transactionId || !checkout.checkoutUrl.startsWith("https://")) {
  throw new Error("Paddle sandbox did not return a hosted checkout URL");
}
console.log(`OK   Paddle sandbox catalog and hosted checkout are reachable (transaction ${checkout.transactionId})`);
