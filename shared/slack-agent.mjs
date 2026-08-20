// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The pure half of the Slack agent: everything the events route needs that has no I/O in it.
 *
 * The route itself has to talk to Slack, Anthropic and Supabase and cannot be tested without them. The
 * three things that are actually easy to get wrong — verifying Slack's request signature, pulling the
 * real question out of an @-mention, and turning the assistant's rich markdown into Slack's flavour —
 * are all pure string work, so they live here and `tests/slack-agent.test.mjs` drives them directly.
 *
 * Plain ESM, no imports but `node:crypto` (a builtin), on purpose: a test can import this file and
 * exercise the signature check without standing anything up.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Slack signs every request `v0=<hex>`; the version is part of the signed string, not decoration. */
const SIGNATURE_VERSION = "v0";
/**
 * How old a request may be and still be honoured. Slack's own guidance is five minutes: it is the
 * window that stops a captured request being replayed later, and it is long enough that ordinary clock
 * skew between Slack and the server never trips it.
 */
const MAX_SKEW_SECONDS = 300;

/**
 * Whether a request genuinely came from Slack.
 *
 * The signature is an HMAC-SHA256 over `v0:{timestamp}:{raw body}` keyed with the app's signing secret,
 * so the raw body has to be hashed exactly as it arrived — parse it into JSON first and re-serialise and
 * the bytes differ and every request looks forged. The timestamp is checked before the hash to refuse a
 * replay of an old but validly signed request, and the comparison is constant-time so a caller cannot
 * learn the secret one byte at a time by timing the failures.
 *
 * @param {{ signingSecret: string; timestamp: string; body: string; signature: string; now?: number }} opts
 * @returns {boolean}
 */
export function verifySlackSignature(opts) {
  const { signingSecret, timestamp, body, signature } = opts;
  if (!signingSecret || !timestamp || !signature) return false;

  const sent = Number(timestamp);
  if (!Number.isFinite(sent)) return false;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - sent) > MAX_SKEW_SECONDS) return false;

  const expected = `${SIGNATURE_VERSION}=${createHmac("sha256", signingSecret).update(`${SIGNATURE_VERSION}:${timestamp}:${body}`).digest("hex")}`;
  // `timingSafeEqual` throws on a length mismatch, which a forged signature of the wrong length would
  // cause; that is still a "no", so the throw is caught rather than surfaced.
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * The question, with the bot mention and Slack's link syntax taken out.
 *
 * An `app_mention` arrives as "<@U123BOT> how did Cotool do this week", and the leading mention is
 * noise the model should never see. Every `<@U…>` token goes, and Slack's `<url|label>` and `<url>`
 * link forms are reduced to their human text so the model reads "the dashboard" rather than the angle
 * brackets. What is left is trimmed; an empty result means the mention had no question in it.
 *
 * @param {string} text
 * @returns {string}
 */
export function cleanMention(text) {
  return String(text ?? "")
    // User and bot mentions: <@U123> and <@U123|name>.
    .replace(/<@[A-Z0-9]+(\|[^>]*)?>/gi, " ")
    // Channel mentions: <#C123|name>.
    .replace(/<#[A-Z0-9]+(\|[^>]*)?>/gi, " ")
    // Links: <https://x|label> keeps the label, <https://x> keeps the url.
    .replace(/<(https?:[^>|]+)\|([^>]+)>/gi, "$2")
    .replace(/<(https?:[^>]+)>/gi, "$1")
    // Slack's special mentions: <!here>, <!channel>.
    .replace(/<![^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The fenced blocks the web app renders as visuals and Slack cannot. Their JSON body is noise in chat. */
const VISUAL_LANGS = new Set(["stats", "chart", "map", "cards", "timeline", "export"]);

/**
 * Drops the visual and export fenced blocks, leaving the prose and tables that carry the same numbers.
 *
 * The assistant is told these blocks only ever restate figures already in the answer's words or its
 * table, so removing them loses no information — where in Slack their raw JSON would be a wall of braces
 * nobody can read. A generic code block (no language, or a real one) is left untouched.
 *
 * @param {string} markdown
 * @returns {string}
 */
function stripVisualBlocks(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const out = [];
  let dropping = false;
  for (const line of lines) {
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const lang = (fence[1] ?? "").toLowerCase();
      if (!dropping && VISUAL_LANGS.has(lang)) {
        dropping = true;
        continue;
      }
      if (dropping) {
        // The closing fence of a block we are dropping.
        dropping = false;
        continue;
      }
    }
    if (!dropping) out.push(line);
  }
  return out.join("\n");
}

/** A cell's markdown reduced to plain text, so a fixed-width table does not carry stray `**` or links. */
const plainCell = (cell) => inlineToMrkdwn(cell).replace(/\*/g, "").trim();

/**
 * Rewrites GitHub-flavoured tables as a monospace block, because Slack has no table.
 *
 * A markdown table is a header row, a `---` separator, then body rows. Slack renders none of that, so
 * the columns are measured and padded into a code block, which Slack shows in a fixed-width font — the
 * only way rows and columns stay lined up in a message. A run of non-table lines passes through
 * untouched.
 *
 * @param {string} markdown
 * @returns {string}
 */
function tablesToText(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const out = [];
  let index = 0;
  const isRow = (line) => /^\s*\|.*\|\s*$/.test(line);
  const isSeparator = (line) => /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
  const cells = (line) =>
    line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());

  while (index < lines.length) {
    const line = lines[index];
    if (isRow(line) && index + 1 < lines.length && isSeparator(lines[index + 1])) {
      const header = cells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && isRow(lines[index]) && !isSeparator(lines[index])) {
        rows.push(cells(lines[index]));
        index += 1;
      }
      const columns = Math.max(header.length, ...rows.map((row) => row.length));
      const grid = [header, ...rows].map((row) =>
        Array.from({ length: columns }, (_, column) => plainCell(row[column] ?? "")),
      );
      const widths = Array.from({ length: columns }, (_, column) =>
        Math.max(...grid.map((row) => row[column].length)),
      );
      const pad = (row) => row.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
      const rendered = ["```", pad(grid[0]), ...grid.slice(1).map(pad), "```"];
      out.push(...rendered);
      continue;
    }
    out.push(line);
    index += 1;
  }
  return out.join("\n");
}

/**
 * Inline markdown to Slack's mrkdwn, on one line's worth of text.
 *
 * Slack's syntax overlaps markdown but is not it: bold is one asterisk not two, links are `<url|label>`,
 * and there are no headings or images. This does the substitutions that would otherwise show up as raw
 * markup — a `**figure**` printed with its asterisks reads as an error even though the number is right.
 *
 * @param {string} text
 * @returns {string}
 */
export function inlineToMrkdwn(text) {
  return String(text ?? "")
    // Images first, before links, since `![alt](url)` also matches the link pattern.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    // Links: [label](url) -> <url|label>.
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, "<$2|$1>")
    // Bold: **x** or __x__ -> *x*. Done before italics so the inner markers are gone first.
    .replace(/\*\*([^*]+)\*\*/g, "*$1*")
    .replace(/__([^_]+)__/g, "*$1*");
}

/**
 * The assistant's answer, rewritten so it reads correctly in a Slack message.
 *
 * The order is deliberate: the visual blocks are dropped first so their JSON never reaches the table or
 * inline passes, then tables become monospace blocks, then the remaining lines get inline conversion —
 * skipping anything inside a code fence, because a table we just rendered or a block of code the model
 * wrote must not have its contents rewritten. Headings, which Slack has no equivalent for, become bold.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function toSlackText(markdown) {
  const withoutVisuals = stripVisualBlocks(markdown);
  const withTables = tablesToText(withoutVisuals);
  const lines = withTables.split("\n");
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    // A heading has no Slack form; the text of it, bolded, is the closest honest rendering.
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`*${plainCell(heading[1])}*`);
      continue;
    }
    out.push(inlineToMrkdwn(line));
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Slack accepts a large message but shows a truncated one, so an answer longer than this is cut with a
 * marker rather than sent whole and clipped invisibly. The ceiling is well under Slack's own limit,
 * leaving room for the marker and for the header the route may prepend.
 */
const SLACK_MAX_CHARS = 38_000;

/**
 * Trims an answer to Slack's practical limit, closing any open code fence so it does not swallow the marker.
 *
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncateForSlack(text, max = SLACK_MAX_CHARS) {
  const body = String(text ?? "");
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  // If the cut landed inside a code fence, an odd number of fences is open; close it so the marker shows.
  const fences = (cut.match(/```/g) ?? []).length;
  const closer = fences % 2 === 1 ? "\n```" : "";
  return `${cut}${closer}\n\n_…answer truncated for Slack. Ask for a narrower slice, or open Reply Radar for the full version._`;
}
