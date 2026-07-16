import { randomUUID } from "node:crypto";
import { connectCloudRateLimitStore } from "../src/saas/index.js";

const url = process.env.CLOUD_TEST_REDIS_URL?.trim();
if (!url) {
  console.log("SKIP Cloud distributed rate-limit store smoke (CLOUD_TEST_REDIS_URL is not set).");
  process.exit(0);
}

const first = await connectCloudRateLimitStore(url);
const second = await connectCloudRateLimitStore(url);
try {
  const key = `smoke:${randomUUID()}`;
  const one = await first.store.consume(key, 30_000);
  const two = await second.store.consume(key, 30_000);
  const three = await first.store.consume(key, 30_000);
  if (one.count !== 1 || two.count !== 2 || three.count !== 3) {
    throw new Error(`distributed counter mismatch: ${one.count},${two.count},${three.count}`);
  }
  if (one.resetAfterMs <= 0 || three.resetAfterMs > one.resetAfterMs) {
    throw new Error("distributed counter TTL is invalid");
  }
  console.log("OK   independent Node clients share one atomic Valkey/Redis rate-limit counter");
} finally {
  await Promise.all([first.close(), second.close()]);
}
