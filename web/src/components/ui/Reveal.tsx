import { useEffect, useRef, type ReactNode } from "react";
import gsap from "gsap";

/**
 * Görünüm/panel değiştiğinde doğrudan alt elemanları stagger'lı olarak içeri kaydırır.
 * prefers-reduced-motion'da anında görünür — animasyon atlanır.
 */
export function Reveal({ children, trigger, className }: { children: ReactNode; trigger?: unknown; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const targets = Array.from(el.children);
    if (reduced || targets.length === 0) return;
    gsap.fromTo(
      targets,
      { opacity: 0, y: 10 },
      { opacity: 1, y: 0, duration: 0.32, ease: "power2.out", stagger: 0.045, clearProps: "transform" }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trigger]);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
