import { useEffect, useRef, useState } from "react";
import gsap from "gsap";

/** Sayısal değeri VT323 CRT fontuyla sayarak gösterir — dashboard istatistik kutuları için. */
export function Ticker({ value, size = "md" }: { value: number; size?: "sm" | "md" }) {
  const [display, setDisplay] = useState(0);
  const prevRef = useRef(0);

  useEffect(() => {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setDisplay(value);
      prevRef.current = value;
      return;
    }
    const obj = { v: prevRef.current };
    const tween = gsap.to(obj, {
      v: value,
      duration: 0.6,
      ease: "power1.out",
      onUpdate: () => setDisplay(Math.round(obj.v)),
    });
    prevRef.current = value;
    return () => {
      tween.kill();
    };
  }, [value]);

  return <span className={`ticker${size === "sm" ? " ticker--sm" : ""}`}>{display.toLocaleString("en-US")}</span>;
}
