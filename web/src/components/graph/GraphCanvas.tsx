// İlişki grafiği tuvali — Canvas 2D, devre şeması / patch-bay estetiği.
//
// Performans sözleşmesi:
// - rAF döngüsü SADECE sim aktifken (alpha > alphaMin), spawn animasyonu sürerken
//   veya kullanıcı sürüklerken çalışır; boşta tek kare çizilir ve durur.
// - Ekran dışı düğüm/kenar culling + zoom < eşik iken etiket kutuları gizlenir (LOD).
// - Çizim ekran uzayında yapılır, koordinatlar tam sayıya yuvarlanır (+0.5 stroke
//   hizalaması) — 1px çizgiler her zoom seviyesinde crisp kalır.

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { GraphNodeKind, GraphRel } from "../../api";
import type { GraphStore, KindFilter, SimNode } from "./types";
import { reheat } from "./store";

export interface GraphCanvasHandle {
  /** Görünür grafı viewport'a sığdırır. */
  fit(): void;
  /** Tuval merkezine göre çarpanla zoom. */
  zoomBy(factor: number): void;
  /** Viewport'u düğüme odaklar. */
  focusNode(id: string): void;
  /** Viewport merkezinin world koordinatı (yeni düğüm doğurma noktası). */
  centerWorld(): { x: number; y: number };
  /** Bir sonraki karede yeniden çiz (dış mutasyonlardan sonra). */
  redraw(): void;
}

interface GraphCanvasProps {
  store: GraphStore;
  filters: KindFilter;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onExpand: (id: string) => void;
  onZoomChange: (k: number) => void;
  ariaLabel: string;
}

interface View {
  x: number;
  y: number;
  k: number;
}

interface DragState {
  mode: "pan" | "node";
  id?: string;
  lastX: number;
  lastY: number;
  moved: number;
}

const MIN_ZOOM = 0.06;
const MAX_ZOOM = 4;
const LOD_LABELS = 0.5; // altında etiket kutuları gizlenir
const LOD_MICRO = 0.18; // altında sadece minik işaretler
const SPAWN_MS = 240;
const MAX_LABEL_PX = 150;

const MARKER_SIZE: Record<GraphNodeKind, number> = { project: 9, memory: 6, document: 6, session: 6, tag: 4 };
const EDGE_DASH: Record<GraphRel, number[]> = { related: [], belongs: [1, 3], tagged: [4, 3], logged: [7, 3] };

interface Palette {
  fg: [number, number, number];
  accent: string;
  accentStrong: string;
  fgOnAccent: string;
  bg: string;
  bgPanel: string;
  fgHex: string;
  fgDim: string;
  fgFaint: string;
  border: string;
  borderStrong: string;
  mono: string;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function readPalette(): Palette {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string) => cs.getPropertyValue(name).trim();
  return {
    fg: hexToRgb(v("--fg")),
    accent: v("--accent"),
    accentStrong: v("--accent-strong"),
    fgOnAccent: v("--fg-on-accent"),
    bg: v("--bg"),
    bgPanel: v("--bg-panel"),
    fgHex: v("--fg"),
    fgDim: v("--fg-dim"),
    fgFaint: v("--fg-faint"),
    border: v("--border"),
    borderStrong: v("--border-strong"),
    mono: v("--font-mono") || "monospace",
  };
}

const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

function markerColor(kind: GraphNodeKind, p: Palette): string {
  switch (kind) {
    case "memory":
      return p.accent; // fosfor yeşili — hafıza düğümleri ağın "canlı" hücreleri
    case "project":
    case "document":
      return p.fgHex;
    case "session":
      return p.fgDim;
    case "tag":
      return p.fgFaint;
  }
}

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(function GraphCanvas(
  { store, filters, selectedId, onSelect, onExpand, onZoomChange, ariaLabel },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const rafId = useRef(0);
  const drag = useRef<DragState | null>(null);
  const hoverId = useRef<string | null>(null);
  const lastTap = useRef<{ id: string | null; time: number }>({ id: null, time: 0 });
  const palette = useRef<Palette | null>(null);
  const reduced = useRef(false);
  // Props'ların rAF içinden okunan ayna ref'leri (draw closure'ı stale kalmasın).
  const filtersRef = useRef(filters);
  const selectedRef = useRef(selectedId);

  const size = useRef({ w: 0, h: 0, dpr: 1 });

  const setZoom = (k: number) => {
    view.current.k = k;
    onZoomChange(k);
  };

  /** Tek kare çizim planla — döngü gerekiyorsa frame kendini yeniden kurar. */
  const schedule = () => {
    if (!rafId.current) rafId.current = requestAnimationFrame(frame);
  };

  const frame = (now: number) => {
    rafId.current = 0;
    const sim = store.sim;
    let active = false;
    if (sim.alpha() > sim.alphaMin()) {
      sim.tick();
      active = true;
    }
    const animating = draw(now);
    if (active || animating || drag.current) schedule();
  };

  /** Çizer; spawn animasyonu hâlâ sürüyorsa true döner. */
  const draw = (now: number): boolean => {
    const canvas = canvasRef.current;
    const p = palette.current;
    if (!canvas || !p) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    const { w, h, dpr } = size.current;
    const { x: tx, y: ty, k } = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const flt = filtersRef.current;
    const focus = hoverId.current ?? selectedRef.current;
    // Focus modunda komşu kümesi: değen kenarlar/komşular parlak, kalanlar soluk.
    let focusSet: Set<string> | null = null;
    if (focus) {
      focusSet = new Set([focus]);
      for (const l of store.links) {
        const s = l.source as SimNode;
        const t = l.target as SimNode;
        if (s.id === focus) focusSet.add(t.id);
        else if (t.id === focus) focusSet.add(s.id);
      }
    }

    const micro = k < LOD_MICRO;
    const showLabels = k >= LOD_LABELS;
    const margin = 60;

    // --- kenarlar ---
    ctx.lineWidth = 1;
    for (const l of store.links) {
      const s = l.source as SimNode;
      const t = l.target as SimNode;
      if (!flt[s.kind] || !flt[t.kind]) continue;
      const x1 = Math.round((s.x ?? 0) * k + tx) + 0.5;
      const y1 = Math.round((s.y ?? 0) * k + ty) + 0.5;
      const x2 = Math.round((t.x ?? 0) * k + tx) + 0.5;
      const y2 = Math.round((t.y ?? 0) * k + ty) + 0.5;
      // culling: kenarın bbox'ı viewport dışındaysa çizme
      if (Math.max(x1, x2) < -margin || Math.min(x1, x2) > w + margin) continue;
      if (Math.max(y1, y2) < -margin || Math.min(y1, y2) > h + margin) continue;

      let alpha = 0.2;
      if (focus) alpha = s.id === focus || t.id === focus ? 0.8 : 0.06;
      ctx.strokeStyle = rgba(p.fg, alpha);
      ctx.setLineDash(micro ? [] : EDGE_DASH[l.rel]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // --- düğümler ---
    ctx.textBaseline = "middle";
    let animating = false;

    for (const n of store.nodes.values()) {
      if (!flt[n.kind]) {
        n.hitW = 0;
        continue;
      }
      const sx = Math.round((n.x ?? 0) * k + tx);
      const sy = Math.round((n.y ?? 0) * k + ty);
      // culling — sağa doğru etiket payı bırak
      if (sx < -220 || sx > w + 220 || sy < -40 || sy > h + 40) {
        n.hitW = 0;
        continue;
      }

      const isSelected = n.id === selectedRef.current;
      const isHover = n.id === hoverId.current;
      const dimmed = focusSet !== null && !focusSet.has(n.id);

      let spawn = 1;
      if (!reduced.current) {
        spawn = Math.min(1, (now - n.born) / SPAWN_MS);
        if (spawn < 1) animating = true;
      }

      ctx.globalAlpha = (dimmed && !isSelected ? 0.25 : 1) * (0.3 + 0.7 * spawn);

      // işaret karesi
      const ms = Math.max(2, Math.round((micro ? 3 : MARKER_SIZE[n.kind]) * (isHover ? 1.3 : 1) * spawn));
      ctx.fillStyle = isSelected ? p.accentStrong : markerColor(n.kind, p);
      ctx.fillRect(sx - (ms >> 1), sy - (ms >> 1), ms, ms);

      // vuruş kutusu varsayılanı (etiket çizilirse genişler)
      let hx = sx - ms / 2 - 4;
      let hw = ms + 8;
      const hy = sy - 11;
      const hh = 22;

      const drawLabel = (showLabels || isSelected || isHover) && !micro;
      if (drawLabel) {
        const isProject = n.kind === "project";
        ctx.font = `${isProject ? "600 " : ""}11px ${p.mono}`;
        if (n.labelText === undefined) {
          let text = n.label;
          if (ctx.measureText(text).width > MAX_LABEL_PX) {
            while (text.length > 3 && ctx.measureText(`${text}…`).width > MAX_LABEL_PX) text = text.slice(0, -1);
            text += "…";
          }
          n.labelText = text;
          n.labelW = ctx.measureText(text).width;
        }
        const bw = Math.ceil((n.labelW ?? 0) + 12);
        const bh = isProject ? 22 : 18;
        const bx = sx + Math.ceil(ms / 2) + 5;
        const by = sy - (bh >> 1);

        // kutu: zemin + 1px çerçeve (seçili: accent'e ters çevrilir)
        ctx.fillStyle = isSelected ? p.accent : p.bg;
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeStyle = isSelected ? p.accentStrong : isHover ? p.borderStrong : p.border;
        if (n.kind === "tag" && !isSelected) ctx.setLineDash([3, 2]);
        ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, bh - 1);
        ctx.setLineDash([]);
        if (isProject) {
          // proje = ağın hub'ı: çift çerçeve
          ctx.strokeStyle = isSelected ? p.accentStrong : p.borderStrong;
          ctx.strokeRect(bx + 2.5, by + 2.5, bw - 5, bh - 5);
        }

        ctx.fillStyle = isSelected ? p.fgOnAccent : p.fgHex;
        ctx.fillText(n.labelText, bx + 6, by + bh / 2 + 0.5);

        // degree rozeti: ·N
        if (n.degree > 0) {
          ctx.font = `10px ${p.mono}`;
          ctx.fillStyle = p.fgFaint;
          ctx.fillText(`·${n.degree}`, bx + bw + 4, sy + 0.5);
        }

        hx = sx - ms / 2 - 4;
        hw = bx + bw - hx + 4;
      }

      n.hitX = hx;
      n.hitY = hy;
      n.hitW = hw;
      n.hitH = hh;
    }
    ctx.globalAlpha = 1;
    return animating;
  };

  /** Ekran noktasındaki düğüm (üstte çizilen öncelikli — ters sırada tara). */
  const hitTest = (px: number, py: number): SimNode | null => {
    const nodes = [...store.nodes.values()];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!n.hitW) continue;
      if (px >= (n.hitX ?? 0) && px <= (n.hitX ?? 0) + (n.hitW ?? 0) && py >= (n.hitY ?? 0) && py <= (n.hitY ?? 0) + (n.hitH ?? 0))
        return n;
    }
    return null;
  };

  const toWorld = (px: number, py: number) => ({
    x: (px - view.current.x) / view.current.k,
    y: (py - view.current.y) / view.current.k,
  });

  const zoomAt = (px: number, py: number, factor: number) => {
    const { k } = view.current;
    const nk = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k * factor));
    if (nk === k) return;
    view.current.x = px - ((px - view.current.x) / k) * nk;
    view.current.y = py - ((py - view.current.y) / k) * nk;
    setZoom(nk);
    schedule();
  };

  useImperativeHandle(ref, () => ({
    fit() {
      const { w, h } = size.current;
      const visible = [...store.nodes.values()].filter((n) => filtersRef.current[n.kind]);
      if (!visible.length || !w || !h) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const n of visible) {
        minX = Math.min(minX, n.x ?? 0);
        minY = Math.min(minY, n.y ?? 0);
        maxX = Math.max(maxX, n.x ?? 0);
        maxY = Math.max(maxY, n.y ?? 0);
      }
      const bw = Math.max(1, maxX - minX);
      const bh = Math.max(1, maxY - minY);
      const pad = 90;
      const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh, 1.4)));
      view.current.x = w / 2 - ((minX + maxX) / 2) * k;
      view.current.y = h / 2 - ((minY + maxY) / 2) * k;
      setZoom(k);
      schedule();
    },
    zoomBy(factor: number) {
      zoomAt(size.current.w / 2, size.current.h / 2, factor);
    },
    focusNode(id: string) {
      const n = store.nodes.get(id);
      if (!n) return;
      const k = Math.max(view.current.k, 0.9);
      view.current.x = size.current.w / 2 - (n.x ?? 0) * k;
      view.current.y = size.current.h / 2 - (n.y ?? 0) * k;
      setZoom(k);
      schedule();
    },
    centerWorld() {
      return toWorld(size.current.w / 2, size.current.h / 2);
    },
    redraw() {
      schedule();
    },
  }));

  // Kurulum: palet, boyutlandırma, wheel (non-passive), reduced-motion.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    palette.current = readPalette();
    reduced.current = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    const resize = () => {
      const parent = canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const first = size.current.w === 0;
      size.current = { w, h, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      if (first) {
        // İlk açılışta origin'i merkeze al — seed merkez çevresine doğar.
        view.current.x = w / 2;
        view.current.y = h / 2;
      }
      schedule();
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0016));
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    return () => {
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      cancelAnimationFrame(rafId.current);
      rafId.current = 0;
    };
    // schedule/zoomAt stabil (ref tabanlı) — bilinçli boş bağımlılık.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prop aynaları — değişince tek kare tazele.
  useEffect(() => {
    filtersRef.current = filters;
    selectedRef.current = selectedId;
    schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, selectedId]);

  const setCursor = (c: string) => {
    if (canvasRef.current) canvasRef.current.style.cursor = c;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas || e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const hit = hitTest(px, py);
    drag.current = { mode: hit ? "node" : "pan", id: hit?.id, lastX: px, lastY: py, moved: 0 };
    setCursor(hit ? "grabbing" : "grabbing");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const d = drag.current;

    if (!d) {
      const hit = hitTest(px, py);
      const id = hit?.id ?? null;
      if (id !== hoverId.current) {
        hoverId.current = id;
        setCursor(id ? "pointer" : "grab");
        schedule();
      }
      return;
    }

    const dx = px - d.lastX;
    const dy = py - d.lastY;
    d.moved += Math.abs(dx) + Math.abs(dy);
    d.lastX = px;
    d.lastY = py;

    if (d.mode === "pan") {
      view.current.x += dx;
      view.current.y += dy;
      schedule();
    } else if (d.id) {
      const n = store.nodes.get(d.id);
      if (n) {
        const wpt = toWorld(px, py);
        n.fx = wpt.x; // sürüklerken sabitle — bırakınca serbest
        n.fy = wpt.y;
        reheat(store, 0.25);
        schedule();
      }
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const d = drag.current;
    drag.current = null;
    if (!canvas || !d) return;
    canvas.releasePointerCapture(e.pointerId);

    if (d.mode === "node" && d.id) {
      const n = store.nodes.get(d.id);
      if (n) {
        n.fx = null;
        n.fy = null;
      }
    }

    if (d.moved < 5) {
      // tap: seç / boşlukta seçim bırak; çift tap: genişlet
      const id = d.mode === "node" ? (d.id ?? null) : null;
      const now = performance.now();
      if (id && lastTap.current.id === id && now - lastTap.current.time < 350) {
        lastTap.current = { id: null, time: 0 };
        onExpand(id);
      } else {
        lastTap.current = { id, time: now };
        onSelect(id);
      }
    }
    setCursor(hoverId.current ? "pointer" : "grab");
    schedule();
  };

  const onPointerLeave = () => {
    if (hoverId.current) {
      hoverId.current = null;
      schedule();
    }
  };

  return (
    <canvas
      ref={canvasRef}
      className="graph-canvas"
      role="application"
      aria-label={ariaLabel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
    />
  );
});
