// Ofis sahnesi için el ile tasarlanmış 1-bit karakter/dekor piksel matrisleri.
// Dış PNG/asset yok — her şey "0/1" satır dizileri, canvas'a fillRect ile basılır
// (bkz. ../icons/Icons.tsx aynı yaklaşım). '1' = mürekkep (fg), '0' = boşluk.

export type PixelRows = readonly string[];

export const CHAR_W = 7;

/** Baş (3 satır) — agent uid'inden deterministik seçilen 4 varyant. */
export const HEAD_VARIANTS: PixelRows[] = [
  ["0011100", "0111110", "0111110"], // düz
  ["0111110", "0111110", "0100010"], // saçlı
  ["0011100", "0111110", "0101010"], // gözlüklü
  ["1111111", "0011100", "0111110"], // şapkalı
];

/** Uyurken göz satırı override (baş satır index 2 — "göz" hattı). */
export const HEAD_EYES_CLOSED = "0100010";

/** Gövde (3 satır): omuz, kollar, bel. Tüm varyantlarda ortak. */
export const TORSO: PixelRows = ["0111110", "1111111", "0111110"];

/** Klavyede yazarken alt gövde satırı (eller) — 2 kareli döngü. */
export const TYPE_HANDS: [string, string] = ["0111110", "1000001"];

/** Ayaktayken bacaklar (2 satır) — 2 kareli yürüme döngüsü. */
export const LEGS_WALK: [PixelRows, PixelRows] = [
  ["0010100", "0010100"],
  ["0100010", "0001000"],
];

/** Masa: 8x5 art-px — üstte monitör oyuğu. */
export const DESK: PixelRows = [
  "01111110",
  "01111110",
  "01111110",
  "11111111",
  "01001000",
];

/** Monitör gövdesi (ekran alanı ayrı çizilir, içine kod satırı çubukları basılır). */
export const MONITOR_FRAME: PixelRows = ["1111111", "1000001", "1000001", "1111111"];

/** Saksı dekoru. */
export const PLANT: PixelRows = ["0010100", "0111110", "0010100", "0111110", "0011100"];

/** Kahve makinesi dekoru. */
export const COFFEE: PixelRows = ["0111100", "1111110", "1000010", "1111110", "0111100"];

/** Kapı çerçevesi (girişte/çıkışta referans, ayrı çizilir). */
export const DOOR: PixelRows = ["10000001", "10000001", "10000001", "11111111"];

/** agent uid → 0..3 deterministik varyant indeksi (aynı agent hep aynı karakter). */
export function variantForUid(uid: string): number {
  let h = 0;
  for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
  return h % HEAD_VARIANTS.length;
}

export interface DeskSpot {
  /** Karakterin durduğu nokta (art-px, ayak hizası). */
  x: number;
  y: number;
  /** Masa üst-sol köşesi. */
  deskX: number;
  deskY: number;
  /** Monitör üst-sol köşesi. */
  monitorX: number;
  monitorY: number;
}

export interface OfficeLayout {
  artW: number;
  artH: number;
  doorX: number;
  doorY: number;
  desks: DeskSpot[];
  decor: { kind: "plant" | "coffee"; x: number; y: number }[];
}

const DESK_SPACING_X = 34;
const DESK_SPACING_Y = 32;
const MARGIN_X = 22;
const MARGIN_TOP = 24;
const CORRIDOR_H = 30;
const MAX_DESKS = 16;

/**
 * Agent sayısına göre prosedürel ofis düzeni — masa grid'i + kapı + kısa yürüme
 * koridoru. Sadece kapasite BÜYÜDÜĞÜNDE yeniden hesaplanmalı (çağıran taraf
 * kararı) — aksi halde oturan karakterler masa değiştirmiş gibi görünür.
 */
export function buildOffice(deskCount: number): OfficeLayout {
  const n = Math.max(1, Math.min(MAX_DESKS, deskCount));
  const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(n))));
  const rows = Math.ceil(n / cols);

  const artW = MARGIN_X * 2 + (cols - 1) * DESK_SPACING_X + 40;
  const artH = MARGIN_TOP + (rows - 1) * DESK_SPACING_Y + 40 + CORRIDOR_H;

  const desks: DeskSpot[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const deskX = MARGIN_X + c * DESK_SPACING_X;
    const deskY = MARGIN_TOP + r * DESK_SPACING_Y;
    desks.push({
      x: deskX + 4,
      y: deskY + 13, // masanın önünde duruş noktası (ayak hizası)
      deskX,
      deskY,
      monitorX: deskX + 1,
      monitorY: deskY - 8,
    });
  }

  const doorX = Math.round(artW / 2);
  const doorY = artH - 6;

  const decor: OfficeLayout["decor"] = [];
  if (artW > 90) {
    decor.push({ kind: "plant", x: 6, y: artH - CORRIDOR_H - 10 });
    decor.push({ kind: "coffee", x: artW - 16, y: artH - CORRIDOR_H - 10 });
  }

  return { artW, artH, doorX, doorY, desks, decor };
}
