import { createClient } from "@redis/client";
import type { CloudRateLimitStore } from "./cloud-security.js";

const CONSUME_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return { count, ttl }
`;

export interface ConnectedCloudRateLimitStore {
  store: CloudRateLimitStore;
  close(): Promise<void>;
}

/** Atomic fixed-window limiter shared by every Node replica using the same Redis/Valkey. */
export async function connectCloudRateLimitStore(url: string): Promise<ConnectedCloudRateLimitStore> {
  const client = createClient({
    url,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: (retries) => retries >= 5 ? false : Math.min(250 * 2 ** retries, 5_000),
    },
  });
  client.on("error", (error) => {
    console.error(`[hub] Cloud rate-limit store error: ${error.name}`);
  });
  await client.connect();
  return {
    store: {
      async consume(key, windowMs) {
        const reply = await client.eval(CONSUME_SCRIPT, {
          keys: [`mnema:cloud-rate:${key}`],
          arguments: [String(windowMs)],
        });
        if (!Array.isArray(reply) || reply.length !== 2) {
          throw new Error("Cloud rate-limit store returned an invalid response");
        }
        const count = Number(reply[0]);
        const resetAfterMs = Number(reply[1]);
        if (!Number.isInteger(count) || count < 1 || !Number.isFinite(resetAfterMs) || resetAfterMs < 0) {
          throw new Error("Cloud rate-limit store returned invalid counters");
        }
        return { count, resetAfterMs };
      },
    },
    async close() {
      if (client.isOpen) await client.close();
    },
  };
}
