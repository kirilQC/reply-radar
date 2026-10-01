// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

/**
 * The dashboard's background: points drifting slowly and joining with thin lines when they come close.
 *
 * Kiril picked "Network" at full strength from the background options. It covers only the content area
 * (never the sidebar), takes the accent colour so it follows whatever accent someone chose, pauses while
 * the tab is hidden, and draws one still frame for anyone who prefers reduced motion.
 */

import { useEffect, useRef } from "react";

const STRENGTH = 1.6;
const LINK_DISTANCE = 150;

export default function DashboardNetwork() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let raf = 0;
    let rgb = [101, 235, 224];
    let points: Array<{ x: number; y: number; vx: number; vy: number }> = [];

    const readAccent = () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
      if (match) rgb = [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
    };
    const colour = (alpha: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.min(1, alpha * STRENGTH)})`;

    /** The canvas is fixed to the viewport but sized and placed over the content column only. */
    const place = () => {
      const box = host.getBoundingClientRect();
      width = Math.max(1, Math.round(box.width));
      height = window.innerHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.style.left = `${box.left}px`;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = Math.round((width * height) / 26_000);
      while (points.length < target) points.push({ x: Math.random() * width, y: Math.random() * height, vx: (Math.random() - 0.5) * 0.24, vy: (Math.random() - 0.5) * 0.24 });
      points = points.slice(0, target).map((p) => ({ ...p, x: Math.min(p.x, width), y: Math.min(p.y, height) }));
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (const p of points) {
        if (!reduce) { p.x += p.vx; p.y += p.vy; }
        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        for (let j = i + 1; j < points.length; j += 1) {
          const b = points[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < LINK_DISTANCE) {
            ctx.strokeStyle = colour((1 - d / LINK_DISTANCE) * 0.12);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
        ctx.fillStyle = colour(0.3);
        ctx.beginPath();
        ctx.arc(a.x, a.y, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = () => {
      draw();
      raf = requestAnimationFrame(loop);
    };
    const start = () => { cancelAnimationFrame(raf); if (reduce) draw(); else raf = requestAnimationFrame(loop); };
    const onVisibility = () => { if (document.hidden) cancelAnimationFrame(raf); else start(); };
    const onAccent = () => { readAccent(); if (reduce) draw(); };

    readAccent();
    place();
    start();
    const observer = new ResizeObserver(() => { place(); if (reduce) draw(); });
    observer.observe(host);
    window.addEventListener("resize", place);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("reply-radar-appearance-changed", onAccent);
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", place);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("reply-radar-appearance-changed", onAccent);
    };
  }, []);

  return <canvas ref={ref} className="dash-network" aria-hidden="true" />;
}
