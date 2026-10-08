// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Items the team closed on a morning brief stay closed.
 *
 * When someone replies "4. done" under a brief, the reply handler strikes item 4 through in Slack and in the
 * stored body. The next brief was trusted to read that and not raise the item again, and it did not hold:
 * Camb's Oct 8 brief re-raised "manual updates on a regular cadence" and "CA002 approval" 51 minutes after
 * Ben marked both done, rebuilt from the older call notes and reworded. A prompt rule alone is a request.
 *
 * So the struck items of every recent brief are collected (`struckItems`), handed to the model as a list,
 * and then enforced: any item in the new brief that is plainly the same task as a closed one is removed
 * before it is posted (`dropClosedItems`). Matching is on content words, so a rewording is still caught,
 * and strict enough (most of the shorter title's words, at least three of them) that a different task about
 * the same campaign is not. Pure, so tests/brief-closed.test.mjs drives it with the real Camb briefs.
 */

const ITEM_LINE = /^(\s*)(\d+)\.\s+(.*)$/;
const DIVIDER = /^\s*=+\s*$/;

/** A Slack mention or formatting stripped down to the words a person reads. */
function plain(text) {
  return String(text ?? "")
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "$1")
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<[^|>]+\|([^>]+)>/g, "$1")
    .replace(/[~*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The task an item line names: its bold part when it has one ("Ben to *send the list*" → "send the list"). */
export function itemTitle(line) {
  const text = String(line ?? "").replace(ITEM_LINE, "$3");
  const bold = text.match(/\*([^*]+)\*/);
  return plain(bold ? bold[1] : text);
}

/** The titles of every item struck through in a brief body ("2. ~*send the updates*~"). */
export function struckItems(body) {
  const out = [];
  for (const line of String(body ?? "").split("\n")) {
    const match = line.match(ITEM_LINE);
    if (!match || !match[3].trim().startsWith("~")) continue;
    const title = itemTitle(line);
    if (title) out.push(title);
  }
  return out;
}

const STOP = new Set([
  "a", "an", "the", "to", "and", "or", "of", "for", "on", "in", "into", "with", "by", "at", "from", "it", "its",
  "this", "that", "their", "them", "our", "we", "is", "be", "are", "was", "as", "up", "out", "so", "any", "all",
]);

/** Content words, lowercased, with campaign codes and numbers kept whole ("ca002", "e-commerce" → "ecommerce"). */
export function words(text) {
  return new Set(
    plain(text)
      .toLowerCase()
      .replace(/[’']/g, "")
      .replace(/-/g, "")
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 1 && !STOP.has(word))
      .map((word) => (word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)),
  );
}

/** The closed title this one is plainly the same task as, or "" for none. */
export function closedMatch(title, closed) {
  const mine = words(title);
  if (mine.size < 2) return "";
  for (const other of closed) {
    const theirs = words(other);
    if (theirs.size < 2) continue;
    let shared = 0;
    for (const word of mine) if (theirs.has(word)) shared += 1;
    const smaller = Math.min(mine.size, theirs.size);
    if (shared >= 3 && shared / smaller >= 0.6) return other;
  }
  return "";
}

/**
 * The brief with every item that matches a closed one taken out, each section renumbered from 1, and a
 * section left with no items saying so. An item is its numbered line plus the indented lines under it.
 * Struck items in the new body are left alone (the model chose to show something closed as closed).
 * @param {string} body
 * @param {string[]} closed
 * @returns {{ body: string, dropped: Array<{ title: string, closedAs: string }> }}
 */
export function dropClosedItems(body, closed) {
  const list = (Array.isArray(closed) ? closed : []).filter(Boolean);
  if (!list.length) return { body: String(body ?? ""), dropped: [] };
  const lines = String(body ?? "").split("\n");
  const out = [];
  const dropped = [];
  let skipping = false;
  let number = 0;
  let sectionHadItems = false;
  let sectionKept = 0;
  const closeSection = () => {
    if (sectionHadItems && sectionKept === 0) {
      while (out.length && !out[out.length - 1].trim()) out.pop();
      out.push("", "Nothing open here right now.", "", "");
    }
    sectionHadItems = false;
    sectionKept = 0;
    number = 0;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // A divider ends a section, but the header is fenced by two of them, so only the first divider after
    // items counts as the end.
    if (DIVIDER.test(line)) {
      skipping = false;
      if (sectionHadItems) closeSection();
      out.push(line);
      continue;
    }
    const item = line.match(ITEM_LINE);
    if (item && item[1].length === 0) {
      sectionHadItems = true;
      const struck = item[3].trim().startsWith("~");
      const same = struck ? "" : closedMatch(itemTitle(line), list);
      if (same) {
        dropped.push({ title: itemTitle(line), closedAs: same });
        skipping = true;
        continue;
      }
      skipping = false;
      number += 1;
      sectionKept += 1;
      out.push(`${number}. ${item[3]}`);
      continue;
    }
    // The bullets and blank lines that belong to a dropped item go with it.
    if (skipping) {
      if (!line.trim() || /^\s+/.test(line)) continue;
      skipping = false;
    }
    out.push(line);
  }
  if (sectionHadItems) closeSection();
  return { body: out.join("\n").replace(/\n{4,}/g, "\n\n\n").replace(/\s+$/, ""), dropped };
}
