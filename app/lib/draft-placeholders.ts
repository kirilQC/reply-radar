// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The blanks the draft model leaves for a person to fill: "(insert time here)", "[link]".
 *
 * Shared by the inbox composer, which highlights them, and the Slack reply alert, which refuses to send
 * a reply that still has one. Kept free of React so the server can import it.
 */
export const PLACEHOLDER_PATTERN =
  /\((?:insert|add|your|enter)[^)]{0,40}\)|\[(?:insert|add|your|enter|link|time|date|name)[^\]]{0,40}\]/gi;

export const firstPlaceholder = (text: string): string | null => text.match(new RegExp(PLACEHOLDER_PATTERN.source, "i"))?.[0] ?? null;

/** Text split into plain runs and blanks, for drawing the highlights. */
export function splitPlaceholders(text: string): Array<{ text: string; blank: boolean }> {
  const parts: Array<{ text: string; blank: boolean }> = [];
  let last = 0;
  for (const match of text.matchAll(new RegExp(PLACEHOLDER_PATTERN.source, "gi"))) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), blank: false });
    parts.push({ text: match[0], blank: true });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), blank: false });
  return parts;
}
