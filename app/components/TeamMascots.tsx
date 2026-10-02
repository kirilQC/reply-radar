// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Ten mascot faces a teammate can pick instead of uploading a photo. Stored on the person as
 * `avatarUrl = "mascot:<id>"`, so every place that already shows a person's avatar keeps working.
 * Drawn as small SVGs (no image files), each a round face on its own colour.
 */

type Mascot = { id: string; label: string; bg: string; face: (k: string) => React.ReactNode };

const eyes = (y = 20, dx = 6, r = 2.3) => (
  <>
    <circle cx={20 - dx} cy={y} r={r} fill="#1b1d24" /><circle cx={20 + dx} cy={y} r={r} fill="#1b1d24" />
    <circle cx={20 - dx + 0.8} cy={y - 0.8} r={0.7} fill="#fff" /><circle cx={20 + dx + 0.8} cy={y - 0.8} r={0.7} fill="#fff" />
  </>
);
const smile = (y = 25.5) => <path d={`M17 ${y}q3 2.6 6 0`} fill="none" stroke="#1b1d24" strokeWidth="1.4" strokeLinecap="round" />;
const blush = (y = 24) => (<><ellipse cx="11.5" cy={y} rx="2.2" ry="1.3" fill="#ff8fa3" opacity=".55" /><ellipse cx="28.5" cy={y} rx="2.2" ry="1.3" fill="#ff8fa3" opacity=".55" /></>);

export const MASCOTS: Mascot[] = [
  { id: "fox", label: "Fox", bg: "#ff9a52", face: () => (<>
    <path d="M7 8l7 9-7 2z M33 8l-7 9 7 2z" fill="#ff9a52" stroke="#e6762a" strokeWidth="1" />
    <circle cx="20" cy="22" r="12" fill="#ff9a52" /><path d="M10 24q10 14 20 0q-4 9-10 9t-10-9z" fill="#fff4ea" />
    {eyes(20)}<circle cx="20" cy="26" r="1.6" fill="#1b1d24" /></>) },
  { id: "owl", label: "Owl", bg: "#b08a63", face: () => (<>
    <path d="M9 10l5 5M31 10l-5 5" stroke="#8a6643" strokeWidth="3" strokeLinecap="round" />
    <circle cx="20" cy="22" r="12.5" fill="#b08a63" /><circle cx="14.5" cy="20" r="5" fill="#fff4dd" /><circle cx="25.5" cy="20" r="5" fill="#fff4dd" />
    {eyes(20, 5.5, 2.6)}<path d="M18.5 24.5l1.5 2.5 1.5-2.5z" fill="#f2b33d" /></>) },
  { id: "cat", label: "Cat", bg: "#9aa3b5", face: () => (<>
    <path d="M9 9l5 8-6 2zM31 9l-5 8 6 2z" fill="#9aa3b5" />
    <circle cx="20" cy="22" r="12" fill="#9aa3b5" />{eyes(21)}<path d="M19 24.5h2l-1 1.2z" fill="#ff8fa3" />{smile(26.5)}
    <path d="M8 24h6M8 27h6M26 24h6M26 27h6" stroke="#5f6676" strokeWidth=".8" strokeLinecap="round" /></>) },
  { id: "bear", label: "Bear", bg: "#a8744f", face: () => (<>
    <circle cx="10" cy="12" r="4.5" fill="#a8744f" /><circle cx="30" cy="12" r="4.5" fill="#a8744f" />
    <circle cx="20" cy="22" r="12" fill="#a8744f" /><ellipse cx="20" cy="26" rx="5.5" ry="4" fill="#e8c9a6" />
    {eyes(20)}<ellipse cx="20" cy="24.6" rx="1.8" ry="1.2" fill="#1b1d24" /></>) },
  { id: "frog", label: "Frog", bg: "#6fcf7c", face: () => (<>
    <circle cx="13" cy="13" r="5" fill="#6fcf7c" /><circle cx="27" cy="13" r="5" fill="#6fcf7c" />
    <circle cx="20" cy="23" r="12" fill="#6fcf7c" />{eyes(13, 7, 2.6)}{blush(25)}
    <path d="M13 26q7 5 14 0" fill="none" stroke="#1b1d24" strokeWidth="1.4" strokeLinecap="round" /></>) },
  { id: "panda", label: "Panda", bg: "#f2f3f5", face: () => (<>
    <circle cx="10" cy="12" r="4.5" fill="#2a2d36" /><circle cx="30" cy="12" r="4.5" fill="#2a2d36" />
    <circle cx="20" cy="22" r="12" fill="#f7f8fa" /><ellipse cx="14" cy="20.5" rx="3.6" ry="4.4" fill="#2a2d36" transform="rotate(-18 14 20.5)" />
    <ellipse cx="26" cy="20.5" rx="3.6" ry="4.4" fill="#2a2d36" transform="rotate(18 26 20.5)" />
    <circle cx="14.5" cy="20" r="1.3" fill="#fff" /><circle cx="25.5" cy="20" r="1.3" fill="#fff" />
    <ellipse cx="20" cy="25" rx="1.8" ry="1.2" fill="#2a2d36" />{smile(27)}</>) },
  { id: "penguin", label: "Penguin", bg: "#36507a", face: () => (<>
    <circle cx="20" cy="21" r="13" fill="#2b3e60" /><path d="M10 22q0-9 10-9t10 9q0 9-10 10-10-1-10-10z" fill="#f7f8fa" />
    {eyes(20, 4.5)}<path d="M18 23h4l-2 2.6z" fill="#f2b33d" />{blush(24.5)}</>) },
  { id: "bunny", label: "Bunny", bg: "#f6b8cf", face: () => (<>
    <ellipse cx="14.5" cy="8" rx="3" ry="7.5" fill="#fbe3ec" /><ellipse cx="25.5" cy="8" rx="3" ry="7.5" fill="#fbe3ec" />
    <ellipse cx="14.5" cy="8.5" rx="1.4" ry="5" fill="#f6a5c0" /><ellipse cx="25.5" cy="8.5" rx="1.4" ry="5" fill="#f6a5c0" />
    <circle cx="20" cy="23" r="11.5" fill="#fbe3ec" />{eyes(22)}<path d="M19 25h2l-1 1.1z" fill="#f06a96" />{blush(26)}</>) },
  { id: "octopus", label: "Octopus", bg: "#9b7cf2", face: () => (<>
    <path d="M9 22q0-13 11-13t11 13v6q-2 4-4 0-2 4-4 0-2 4-4 0-2 4-4 0-2 4-4 0-2 4-3 0z" fill="#9b7cf2" />
    {eyes(19)}{blush(23)}{smile(23.5)}</>) },
  { id: "axolotl", label: "Axolotl", bg: "#65ebe0", face: () => (<>
    <path d="M7 15l5 3M6 20l6 1M7 25l5-2M33 15l-5 3M34 20l-6 1M33 25l-5-2" stroke="#ff8fb3" strokeWidth="2.4" strokeLinecap="round" />
    <ellipse cx="20" cy="21" rx="11.5" ry="10.5" fill="#65ebe0" />{eyes(20, 5.5)}{blush(24)}{smile(24.5)}</>) },
];

export const isMascot = (url?: string | null) => typeof url === "string" && url.startsWith("mascot:");
export const mascotOf = (url?: string | null) => (isMascot(url) ? MASCOTS.find((m) => `mascot:${m.id}` === url) ?? null : null);

export function MascotFace({ id, size = 24, className = "" }: { id: string; size?: number; className?: string }) {
  const m = MASCOTS.find((x) => x.id === id) ?? MASCOTS[0];
  return (
    <svg viewBox="0 0 40 40" className={`team-mascot ${className}`} style={{ width: size, height: size, borderRadius: "50%", background: `color-mix(in srgb, ${m.bg} 28%, #12141a)`, flex: "none", display: "block" }} role="img" aria-label={m.label}>
      {m.face(m.id)}
    </svg>
  );
}

/** Keeps a new teammate's name to one word of up to 10 characters. */
export const cleanPersonName = (raw: string) => raw.replace(/\s+/g, "").slice(0, 10);
