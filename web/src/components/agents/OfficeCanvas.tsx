// Agents ofis sahnesi — Canvas 2D, katı 1-bit pixel-art (2 renk + dithering yok,
// sadece fg/bg + tek accent). Düşük çözünürlükte ("sanat pikseli") çizilip
// image-rendering:pixelated ile tam sayı ölçekte büyütülür (bkz. Mac 1984 hissi).
//
// Performans: rAF döngüsü sadece animasyon sürerken veya sekme görünürken çalışır
// (document.hidden -> durur, visibilitychange ile devam eder).

import { useEffect, useImperativeHandle, useRef, forwardRef } from "react";
import type { AgentPresence } from "../../api";
import {
  buildOffice,
  variantForUid,
  HEAD_VARIANTS,
  HEAD_EYES_CLOSED,
  TORSO,
  TYPE_HANDS,
  LEGS_WALK,
  DESK,
  MONITOR_FRAME,
  PLANT,
  COFFEE,
  CHAR_W,
  type OfficeLayout,
  type PixelRows,
} from "./sprites";

type SceneStatus = "entering" | "working" | "stale" | "leaving" | "fadeout";

interface SceneChar {
  uid: string;
  variant: number;
  deskIndex: number;
  data: AgentPresence;
  status: SceneStatus;
  x: number;
  y: number;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  animStart: number;
  animDurMs: number;
  opacity: number;
  codeLines: number[];
  lastCodeTick: number;
  // ekran uzayı vuruş kutusu (hitTest için, draw() tarafından doldurulur)
  hitX: number;
  hitY: number;
  hitW: number;
  hitH: number;
}

const WALK_MS = 900;
const FADE_MS = 380;

export interface OfficeCanvasHandle {
  redraw(): void;
}

interface OfficeCanvasProps {
  agents: AgentPresence[];
  selectedUid: string | null;
  onSelect: (uid: string | null) => void;
  ariaLabel: string;
}

interface Palette {
  fg: string;
  fgDim: string;
  fgFaint: string;
  bg: string;
  bgPanel: string;
  accent: string;
  warn: string;
  mono: string;
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    fg: v("--fg"),
    fgDim: v("--fg-dim"),
    fgFaint: v("--fg-faint"),
    bg: v("--bg"),
    bgPanel: v("--bg-panel"),
    accent: v("--accent"),
    warn: v("--warn"),
    mono: v("--font-mono") || "monospace",
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function drawRows(ctx: CanvasRenderingContext2D, rows: PixelRows, ox: number, oy: number, color: string): void {
  ctx.fillStyle = color;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === "1") ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
}

/** Ayaktaki (yürüyen) karakteri çizer: baş + gövde + bacaklar. */
function drawWalking(ctx: CanvasRenderingContext2D, ox: number, oy: number, variant: number, frame: number, color: string): void {
  drawRows(ctx, HEAD_VARIANTS[variant], ox, oy, color);
  drawRows(ctx, TORSO, ox, oy + 3, color);
  drawRows(ctx, LEGS_WALK[frame % 2], ox, oy + 6, color);
}

/** Masada oturan karakteri çizer: baş + gövde (bacaklar masanın arkasında gizli). */
function drawSeated(ctx: CanvasRenderingContext2D, ox: number, oy: number, variant: number, hands: string, eyesClosed: boolean, color: string): void {
  const head = eyesClosed ? [HEAD_VARIANTS[variant][0], HEAD_EYES_CLOSED, HEAD_VARIANTS[variant][2]] : HEAD_VARIANTS[variant];
  drawRows(ctx, head, ox, oy, color);
  drawRows(ctx, [TORSO[0], TORSO[1], hands], ox, oy + 3, color);
}

export const OfficeCanvas = forwardRef<OfficeCanvasHandle, OfficeCanvasProps>(function OfficeCanvas(
  { agents, selectedUid, onSelect, ariaLabel },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scene = useRef<Map<string, SceneChar>>(new Map());
  const layoutRef = useRef<OfficeLayout>(buildOffice(4));
  const capacityRef = useRef(4);
  const paletteRef = useRef<Palette | null>(null);
  const reduced = useRef(false);
  const rafId = useRef(0);
  const scaleRef = useRef(3);
  const sizeRef = useRef({ w: 0, h: 0 });
  const hoverUid = useRef<string | null>(null);
  const selectedRef = useRef(selectedUid);
  const hiddenRef = useRef(false);

  const schedule = () => {
    if (hiddenRef.current) return;
    if (!rafId.current) rafId.current = requestAnimationFrame(frame);
  };

  useImperativeHandle(ref, () => ({
    redraw() {
      schedule();
    },
  }));

  /** Boş masa bul: entering/working/stale durumundaki karakterlerin işgal ettiği masalar hariç. */
  const assignDesk = (layout: OfficeLayout): number => {
    const used = new Set<number>();
    for (const c of scene.current.values()) {
      if (c.status === "entering" || c.status === "working" || c.status === "stale") used.add(c.deskIndex);
    }
    for (let i = 0; i < layout.desks.length; i++) if (!used.has(i)) return i;
    return layout.desks.length - 1;
  };

  // --- veri değişince sahneyi yeniden uzlaştır (uzamsal animasyon burada tetiklenir) ---
  useEffect(() => {
    const now = performance.now();
    const neededCapacity = Math.max(capacityRef.current, agents.length);
    if (neededCapacity > capacityRef.current) {
      capacityRef.current = neededCapacity;
      layoutRef.current = buildOffice(neededCapacity);
    }
    const layout = layoutRef.current;
    const seen = new Set(agents.map((a) => a.uid));

    for (const a of agents) {
      let c = scene.current.get(a.uid);
      if (!c) {
        const deskIndex = assignDesk(layout);
        const seat = layout.desks[deskIndex];
        c = {
          uid: a.uid,
          variant: variantForUid(a.uid),
          deskIndex,
          data: a,
          status: "entering",
          x: layout.doorX,
          y: layout.doorY,
          fromX: layout.doorX,
          fromY: layout.doorY,
          toX: seat.x,
          toY: seat.y,
          animStart: now,
          animDurMs: WALK_MS,
          opacity: 1,
          codeLines: [3, 5, 2, 4],
          lastCodeTick: now,
          hitX: 0,
          hitY: 0,
          hitW: 0,
          hitH: 0,
        };
        scene.current.set(a.uid, c);
      } else {
        c.data = a;
        if (c.status === "working" || c.status === "stale") {
          c.status = a.stale ? "stale" : "working";
        }
      }
    }

    for (const [uid, c] of scene.current) {
      if (!seen.has(uid) && c.status !== "leaving" && c.status !== "fadeout") {
        c.status = "leaving";
        c.fromX = c.x;
        c.fromY = c.y;
        c.toX = layout.doorX;
        c.toY = layout.doorY;
        c.animStart = now;
        c.animDurMs = WALK_MS;
      }
    }

    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  useEffect(() => {
    selectedRef.current = selectedUid;
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUid]);

  const update = (now: number): boolean => {
    let animating = false;
    for (const [uid, c] of [...scene.current]) {
      if (c.status === "entering" || c.status === "leaving") {
        const t = reduced.current ? 1 : Math.min(1, (now - c.animStart) / c.animDurMs);
        const e = easeInOut(t);
        c.x = c.fromX + (c.toX - c.fromX) * e;
        c.y = c.fromY + (c.toY - c.fromY) * e;
        if (t < 1) {
          animating = true;
        } else if (c.status === "entering") {
          c.status = c.data.stale ? "stale" : "working";
        } else {
          c.status = "fadeout";
          c.animStart = now;
          c.animDurMs = FADE_MS;
          animating = true;
        }
      } else if (c.status === "fadeout") {
        const t = reduced.current ? 1 : Math.min(1, (now - c.animStart) / c.animDurMs);
        c.opacity = 1 - t;
        if (t < 1) {
          animating = true;
        } else {
          scene.current.delete(uid);
          if (selectedRef.current === uid) onSelect(null);
        }
      } else {
        animating = true; // çalışan/uyuklayan karakterler sürekli hafif animasyon ister (klavye/zzz)
      }
      if (now - c.lastCodeTick > 550 && (c.status === "working" || c.status === "entering")) {
        c.codeLines.shift();
        c.codeLines.push(1 + Math.floor(Math.random() * 5));
        c.lastCodeTick = now;
      }
    }
    return animating;
  };

  const draw = (now: number) => {
    const canvas = canvasRef.current;
    const p = paletteRef.current;
    if (!canvas || !p) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const layout = layoutRef.current;
    const scale = scaleRef.current;

    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, layout.artW, layout.artH);

    // zemin
    ctx.fillStyle = p.bg;
    ctx.fillRect(0, 0, layout.artW, layout.artH);
    // duvar çizgisi (üst) + zemin çizgileri (hafif nokta doku, 1-bit)
    ctx.strokeStyle = p.fgFaint;
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, layout.artW - 1, layout.artH - 1);
    for (let x = 4; x < layout.artW; x += 8) {
      for (let y = 4; y < layout.artH; y += 8) {
        ctx.fillStyle = p.fgFaint;
        ctx.fillRect(x, y, 1, 1);
      }
    }

    // kapı
    ctx.fillStyle = p.fgDim;
    ctx.fillRect(layout.doorX - 4, layout.doorY - 2, 8, 3);
    ctx.fillStyle = p.bg;
    ctx.fillRect(layout.doorX - 3, layout.doorY - 1, 6, 2);

    // dekor
    for (const d of layout.decor) {
      drawRows(ctx, d.kind === "plant" ? PLANT : COFFEE, d.x, d.y, p.fgDim);
    }

    // masalar + monitörler
    for (const spot of layout.desks) {
      drawRows(ctx, DESK, spot.deskX, spot.deskY, p.fgDim);
      drawRows(ctx, MONITOR_FRAME, spot.monitorX, spot.monitorY, p.fg);
    }

    // karakterler (y'ye göre sırala — basit derinlik hissi)
    const chars = [...scene.current.values()].sort((a, b) => a.y - b.y);
    for (const c of chars) {
      ctx.globalAlpha = c.opacity;
      const ox = Math.round(c.x - CHAR_W / 2);
      const oyBase = Math.round(c.y - 9);
      const isSelected = c.uid === selectedRef.current;
      const isHover = c.uid === hoverUid.current;
      const color = isSelected ? p.accent : p.fg;

      if (c.status === "entering" || c.status === "leaving") {
        const frame = Math.floor(now / 160) % 2;
        drawWalking(ctx, ox, oyBase, c.variant, frame, color);
      } else if (c.status === "fadeout") {
        drawWalking(ctx, ox, oyBase, c.variant, 0, color);
      } else {
        const oy = oyBase + 6; // oturan karakter masaya daha yakın çizilir
        if (c.status === "stale") {
          drawSeated(ctx, ox, oy, c.variant, TORSO[2], true, p.fgDim);
          // "zzz" balonu — sinüsle hafif zıplar
          const bob = Math.sin(now / 300) * 1.5;
          ctx.fillStyle = p.fgDim;
          ctx.font = `6px ${p.mono}`;
          ctx.fillText("z z z", ox + 5, oy - 3 + bob);
        } else {
          const frame = Math.floor(now / 220) % 2;
          drawSeated(ctx, ox, oy, c.variant, TYPE_HANDS[frame], false, color);
          // monitör ekranındaki "akan kod satırları"
          const spot = layout.desks[c.deskIndex];
          if (spot) {
            ctx.fillStyle = p.accent;
            let ly = spot.monitorY + 1;
            for (const w of c.codeLines.slice(-3)) {
              ctx.fillRect(spot.monitorX + 1, ly, Math.min(5, w), 1);
              ly += 1;
            }
            // canlı nabız noktası (fresh heartbeat = accent)
            ctx.fillRect(spot.monitorX + 6, spot.monitorY, 1, 1);
          }
        }
      }

      // makine etiketi (küçük, karakterin üstünde)
      ctx.globalAlpha = c.opacity;
      ctx.font = `5px ${p.mono}`;
      ctx.fillStyle = isHover || isSelected ? p.fg : p.fgFaint;
      const label = c.data.machine;
      const tw = ctx.measureText(label).width;
      ctx.fillText(label, Math.round(c.x - tw / 2), oyBase - 2);

      // vuruş kutusu (ekran uzayında, canvas CSS boyutuna göre — pointer event'ler CSS px kullanır)
      c.hitX = ox - 2;
      c.hitY = oyBase - 8;
      c.hitW = CHAR_W + 4;
      c.hitH = 20;
    }
    ctx.globalAlpha = 1;
  };

  const frame = (now: number) => {
    rafId.current = 0;
    const animating = update(now);
    draw(now);
    if (animating) schedule();
  };

  // --- kurulum: palet, boyutlandırma (tam sayı ölçek), visibility, reduced-motion ---
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    paletteRef.current = readPalette();
    reduced.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const layout = layoutRef.current;
      const availW = parent.clientWidth;
      const scale = Math.max(1, Math.min(6, Math.floor(availW / layout.artW)));
      scaleRef.current = scale;
      const cssW = layout.artW * scale;
      const cssH = layout.artH * scale;
      canvas.width = cssW;
      canvas.height = cssH;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      sizeRef.current = { w: cssW, h: cssH };
      schedule();
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const onVisibility = () => {
      hiddenRef.current = document.hidden;
      if (!document.hidden) schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      cancelAnimationFrame(rafId.current);
      rafId.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Kapasite büyüdüğünde tuval boyutunu yeniden hesapla.
  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;
    const layout = layoutRef.current;
    const availW = parent.clientWidth;
    const scale = Math.max(1, Math.min(6, Math.floor(availW / layout.artW)));
    scaleRef.current = scale;
    canvas.width = layout.artW * scale;
    canvas.height = layout.artH * scale;
    canvas.style.width = `${layout.artW * scale}px`;
    canvas.style.height = `${layout.artH * scale}px`;
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents.length]);

  const hitTest = (cssX: number, cssY: number): SceneChar | null => {
    const scale = scaleRef.current;
    const ax = cssX / scale;
    const ay = cssY / scale;
    const chars = [...scene.current.values()];
    for (let i = chars.length - 1; i >= 0; i--) {
      const c = chars[i];
      if (ax >= c.hitX && ax <= c.hitX + c.hitW && ay >= c.hitY && ay <= c.hitY + c.hitH) return c;
    }
    return null;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    const id = hit?.uid ?? null;
    if (id !== hoverUid.current) {
      hoverUid.current = id;
      canvas.style.cursor = id ? "pointer" : "default";
      canvas.title = hit ? `${hit.data.machine} — ${hit.data.task}` : "";
      schedule();
    }
  };

  const onPointerLeave = () => {
    if (hoverUid.current) {
      hoverUid.current = null;
      schedule();
    }
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const hit = hitTest(e.clientX - rect.left, e.clientY - rect.top);
    onSelect(hit?.uid ?? null);
  };

  return (
    <canvas
      ref={canvasRef}
      className="office-canvas"
      role="application"
      aria-label={ariaLabel}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onClick={onClick}
    />
  );
});
