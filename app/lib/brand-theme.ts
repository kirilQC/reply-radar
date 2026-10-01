// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The accent colour, in one place.
 *
 * The default is the QC Command brand teal. A person who picks their own accent keeps it — the
 * appearance panel saves it to their profile — but the old Reply Radar purple is treated as "never
 * chosen": the appearance panel used to save every field on any change, so a purple on file usually
 * means somebody once changed their zoom, not that they wanted purple. Those people now get the teal.
 *
 * `accentInk` is the text colour for anything drawn ON the accent (primary buttons, selected tabs).
 * The teal is light, so white text on it is unreadable; this picks near-black for a light accent and
 * white for a dark one, so whatever accent a person chooses, button labels stay legible.
 */

export const DEFAULT_ACCENT = "#65EBE0";
const LEGACY_DEFAULT_ACCENT = "#8b7cff";

/** The accent to actually use for a stored value: the stored one, unless it is empty or the old default. */
export function resolveAccent(stored: unknown): string {
  const value = String(stored ?? "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) return DEFAULT_ACCENT;
  return value.toLowerCase() === LEGACY_DEFAULT_ACCENT ? DEFAULT_ACCENT : value;
}

/** Near-black on a light accent, white on a dark one (WCAG relative luminance). */
export function accentInk(hex: string): string {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return "#0b0c10";
  const channel = (part: string) => {
    const c = parseInt(part, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(match[1]) + 0.7152 * channel(match[2]) + 0.0722 * channel(match[3]);
  return luminance > 0.36 ? "#0b0c10" : "#ffffff";
}

/** Sets both accent variables on the document. Every place that applies an appearance calls this. */
export function applyAccent(stored: unknown): string {
  const accent = resolveAccent(stored);
  const root = document.documentElement;
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-ink", accentInk(accent));
  return accent;
}
