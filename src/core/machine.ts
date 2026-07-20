import os from "node:os";

/**
 * Bu cihazı tanımlayan kanonik adı döner. Öncelik sırası:
 *   1. HUB_MACHINE_NAME env'i (boş değilse) — operatörün açıkça verdiği ad,
 *      ör. "fatih-pc". machines registry'deki kanonik adalarla tutarlı tutulmalı.
 *   2. os.hostname() — HUB_MACHINE_NAME verilmemişse sistem adına düşer.
 *
 * Presence (`src/core/presence.ts`) ve capabilities (`src/core/capabilities.ts`)
 * bu fonksiyonu kullanır; memory/session kayıtları da origin_machine olarak damgalar.
 */
export function resolveMachineName(): string {
  const env = (process.env.HUB_MACHINE_NAME ?? "").trim();
  if (env.length > 0 && env.length <= 100) return env;
  return os.hostname();
}