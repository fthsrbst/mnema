/**
 * Basit yazma-olayı yayını: push-on-write için. Her başarılı yazma işleminden
 * sonra notifyWrite() çağrılır; server/index.ts bunu dinleyip primary ile
 * debounce'lu anlık senkronizasyon tetikler. Dinleyici yoksa hiçbir maliyeti yok.
 */
type Listener = () => void;

const listeners: Listener[] = [];

export function onWrite(cb: Listener): void {
  listeners.push(cb);
}

export function notifyWrite(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch (err) {
      console.error(`[hub] onWrite dinleyici hatası: ${(err as Error).message}`);
    }
  }
}
