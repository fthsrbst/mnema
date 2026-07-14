import { useEffect, useRef } from "react";

// 8x8 Bayer ordered-dithering eşik matrisi (0..63 normalize edilir).
const BAYER8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

const prefersReducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * 1-bit Bayer-matrix dithering dokusu — hero/arka plan kimliği.
 * Yavaş kayan bir gradyanı eşikleyerek "matbaa noktası" hissi verir.
 * prefers-reduced-motion'da tek bir kare çizip durur.
 */
export function Dither({ cell = 4, opacity = 0.5, className }: { cell?: number; opacity?: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    let t = 0;
    const reduced = prefersReducedMotion();

    const resize = () => {
      const parent = canvas.parentElement;
      const w = parent?.clientWidth ?? 400;
      const h = parent?.clientHeight ?? 200;
      canvas.width = Math.ceil(w / cell);
      canvas.height = Math.ceil(h / cell);
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const draw = () => {
      const w = canvas.width;
      const h = canvas.height;
      const img = ctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          // yavaş dalgalanan gradyan alan: iki diyagonal sinüs bileşimi
          const nx = x / w;
          const ny = y / h;
          const wave =
            0.5 +
            0.5 *
              Math.sin(nx * 6.2 + t * 0.4) *
              Math.cos(ny * 4.1 - t * 0.25 + nx * 2.0);
          const threshold = BAYER8[y % 8][x % 8] / 64;
          const on = wave > threshold;
          const idx = (y * w + x) * 4;
          const v = on ? 255 : 0;
          img.data[idx] = v;
          img.data[idx + 1] = v;
          img.data[idx + 2] = v;
          img.data[idx + 3] = on ? 255 : 0;
        }
      }
      ctx.putImageData(img, 0, 0);
    };

    draw();
    if (!reduced) {
      const loop = () => {
        t += 0.006;
        draw();
        raf = requestAnimationFrame(loop);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [cell]);

  return (
    <canvas
      ref={ref}
      className={className}
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        opacity,
        imageRendering: "pixelated",
        pointerEvents: "none",
        mixBlendMode: "screen",
      }}
    />
  );
}
