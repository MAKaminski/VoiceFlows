"use client";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * Scales its content down to fit its box (never up) — one view per grid cell (ADR 0020). The scale is
 * published as `data-scale` so the metrics tap can measure reflows in layout pixels, not screen pixels.
 */
export function FitBox({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const update = () => {
      const o = outer.current, i = inner.current;
      if (!o || !i || !i.offsetWidth || !i.offsetHeight) return;
      setScale(Math.min(1, (o.clientWidth - 8) / i.offsetWidth, (o.clientHeight - 8) / i.offsetHeight));
    };
    const ro = new ResizeObserver(update);
    if (outer.current) ro.observe(outer.current);
    if (inner.current) ro.observe(inner.current);
    update();
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={outer} style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}>
      <div ref={inner} data-scale={scale} style={{ position: "absolute", left: "50%", top: 4, width: "max-content",
        transform: `translateX(-50%) scale(${scale})`, transformOrigin: "top center" }}>{children}</div>
    </div>
  );
}
