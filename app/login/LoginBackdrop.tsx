// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

/**
 * The login screen's "depth of field" backdrop: three layers of client replies drifting at different
 * distances. The far and near layers are out of focus and the middle one is faint, so the only sharp, bright
 * thing on screen is the password box. The layers shift against each other with the cursor.
 *
 * The replies are invented. This page is shown before anyone has signed in, so nothing real may appear on it.
 *
 * Built imperatively (DOM + Web Animations) rather than as React state: it is pure decoration, re-rendering
 * a few hundred bubbles through React on every frame would be waste, and the whole thing is torn down on
 * unmount. `light()` and `burst()` let the form react to typing and to a successful sign-in.
 */

const REPLIES: [string, string, string, boolean][] = [
  ["Maya R.", "Willow", "Happy to connect. Send over a few times next week?", true],
  ["Theo B.", "Coraa", "Interested. What does onboarding look like on your side?", true],
  ["Ines K.", "Bluevia", "Timing is better in Q1, can you follow up then?", false],
  ["Dev P.", "Chroma", "Can you share pricing for a team of 40?", true],
  ["Hannah L.", "Endform", "Yes, let's book something. Thursday works for me.", true],
  ["Marcus O.", "Arcjet", "Forwarding this to our Head of RevOps.", true],
  ["Sofia G.", "Topo", "Who else are you working with in fintech?", false],
  ["Raj M.", "Galaxy", "This is relevant. Send the one-pager over.", true],
  ["Elena V.", "Moss", "We use a competitor today. What's different?", false],
  ["Noah F.", "Velora", "Booked for Tuesday at 2pm. See you then.", true],
  ["Priya S.", "Hetz", "Loop in my co-founder, she owns this.", true],
  ["Jonas W.", "Roark", "Not a priority this quarter, but keep me posted.", false],
  ["Ava T.", "Willow", "Loved the case study. How fast was the rollout?", true],
  ["Leo C.", "Coraa", "Can we do a quick call tomorrow morning?", true],
  ["Grace H.", "Endform", "Send me a calendar invite and I'll make it work.", true],
  ["Omar A.", "Bluevia", "Is there a free pilot option?", false],
  ["Zoe N.", "Chroma", "Just saw this. Sounds like what we need.", true],
  ["Felix D.", "Arcjet", "What integrations do you support?", false],
  ["Lina Q.", "Galaxy", "Great timing, we were just discussing this.", true],
  ["Sam E.", "Topo", "Happy to chat. 15 minutes on Friday?", true],
];

/** Far, middle, near. Scale, blur, base opacity, parallax depth and drift duration per layer. */
const LAYERS = [
  { scale: 0.62, blur: 2.4, op: 0.22, depth: 8, min: 70000, max: 90000 },
  { scale: 1, blur: 0.4, op: 0.3, depth: 18, min: 42000, max: 60000 },
  { scale: 1.45, blur: 7, op: 0.22, depth: 42, min: 26000, max: 36000 },
];

export type LoginBackdropHandle = { light: () => void; burst: () => void };

const rand = (a: number, b: number) => a + Math.random() * (b - a);

const LoginBackdrop = forwardRef<LoginBackdropHandle>(function LoginBackdrop(_props, ref) {
  const root = useRef<HTMLDivElement>(null);
  const middle = useRef<HTMLDivElement | null>(null);
  const anims = useRef<Animation[]>([]);
  const timers = useRef<number[]>([]);
  const reduce = useRef(false);

  useImperativeHandle(ref, () => ({
    light() {
      const layer = middle.current; if (!layer) return;
      const visible = [...layer.querySelectorAll<HTMLElement>(".lg-msg")].filter((m) => {
        const b = m.getBoundingClientRect();
        return b.width > 0 && b.bottom > 0 && b.top < window.innerHeight && b.right > 0 && b.left < window.innerWidth;
      });
      const m = visible[Math.floor(Math.random() * visible.length)]; if (!m) return;
      m.classList.add("lit");
      timers.current.push(window.setTimeout(() => m.classList.remove("lit"), 1300));
    },
    burst() {
      anims.current.forEach((a) => (a.playbackRate = 6));
      middle.current?.querySelectorAll<HTMLElement>(".lg-msg").forEach((m, i) => { if (i % 2 === 0) m.classList.add("lit"); });
    },
  }));

  useEffect(() => {
    const host = root.current; if (!host) return;
    reduce.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const bubble = ([name, client, text, positive]: (typeof REPLIES)[number]) =>
      `<div class="lg-msg"><b><i class="${positive ? "" : "neu"}"></i>${name} · ${client}</b>${text}</div>`;

    const build = () => {
      anims.current.forEach((a) => a.cancel()); anims.current = [];
      host.querySelectorAll(".lg-layer").forEach((n) => n.remove());
      const holders: HTMLDivElement[] = [];
      LAYERS.forEach((L, li) => {
        const holder = document.createElement("div"); holder.className = "lg-layer";
        const stream = document.createElement("div"); stream.className = "lg-stream";
        stream.style.setProperty("--op", String(L.op)); stream.style.filter = `blur(${L.blur}px)`;
        const cols = Math.max(3, Math.ceil(window.innerWidth / (234 * L.scale)) + (li === 2 ? 0 : 1));
        for (let c = 0; c < cols; c++) {
          const col = document.createElement("div"); col.className = "lg-col";
          const inner = document.createElement("div"); inner.className = "lg-col-inner";
          const html = Array.from({ length: 8 }, (_, i) => bubble(REPLIES[((c + li * 4) * 7 + i * 5) % REPLIES.length])).join("");
          inner.innerHTML = html + html;
          col.appendChild(inner); stream.appendChild(col);
          const down = c % 2 === 1;
          const a = inner.animate(
            [{ transform: `translateY(${down ? "-50%" : "0"})` }, { transform: `translateY(${down ? "0" : "-50%"})` }],
            { duration: rand(L.min, L.max), iterations: Infinity },
          );
          a.playbackRate = reduce.current ? 0.2 : 1;
          anims.current.push(a);
        }
        holder.appendChild(stream);
        // Far to near, all under the dark pool and vignette that sit at the end of the host.
        host.insertBefore(holder, host.querySelector(".lg-pool"));
        holders.push(holder);
      });
      middle.current = holders[1];
      return holders;
    };

    let holders = build();
    const pointer = { x: 0, y: 0, in: false };
    const move = (e: PointerEvent) => { pointer.x = e.clientX / window.innerWidth - 0.5; pointer.y = e.clientY / window.innerHeight - 0.5; pointer.in = true; };
    const leave = () => { pointer.in = false; };
    window.addEventListener("pointermove", move);
    document.addEventListener("pointerleave", leave);

    let px = 0, py = 0, raf = 0, last = performance.now();
    const tick = (now: number) => {
      let dt = Math.min(0.05, (now - last) / 1000); last = now;
      if (reduce.current) dt *= 0.25;
      const tx = pointer.in ? pointer.x : 0, ty = pointer.in ? pointer.y : 0;
      px += (tx - px) * Math.min(1, dt * 2.5); py += (ty - py) * Math.min(1, dt * 2.5);
      holders.forEach((h, i) => { const L = LAYERS[i]; h.style.transform = `translate(${-px * L.depth}px, ${-py * L.depth}px) scale(${L.scale})`; });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    let resizeTimer = 0;
    const resize = () => { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(() => { holders = build(); }, 250); };
    window.addEventListener("resize", resize);

    const pending = timers.current;
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(resizeTimer);
      pending.forEach((t) => window.clearTimeout(t));
      anims.current.forEach((a) => a.cancel());
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", leave);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return (
    <div className="lg-backdrop" ref={root} aria-hidden="true">
      <div className="lg-pool" />
      <div className="lg-vignette" />
    </div>
  );
});

export default LoginBackdrop;
