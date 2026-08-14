/**
 * Turns the assistant's markdown into a structure a React component can render.
 *
 * The chat box used to print the model's reply as preformatted text, which meant a table arrived as
 * a wall of pipes and `**CT50**` arrived with the asterisks showing. Asking the model to stop using
 * markdown was the other option and it is the wrong one: a table is genuinely the right shape for
 * "rank these campaigns", and prose is the right shape for the judgement underneath. So the model
 * keeps writing markdown and this reads it.
 *
 * ── Why a parser lives in this repo at all ──────────────────────────────────────────────────────
 * The app has no runtime dependencies beyond Next and React, and a markdown library is a large
 * amount of code to carry for one screen. This handles the subset a language model actually emits —
 * headings, paragraphs, bullets, numbered lists, GFM tables, fenced code, rules, and inline bold,
 * italic, code and links — and nothing else. Anything unrecognised falls through as plain text,
 * which is the only acceptable failure: an unhandled construct must look plain, never look broken.
 *
 * It is plain `.mjs` in `shared/` so the tests can import it directly, same as the other logic here.
 *
 * The one construct here that is not markdown is the `chart` and `stats` fence, which the model uses
 * to draw. Reading those specs is `answer-visuals.mjs`, because scaling a bar honestly is a separate
 * problem from parsing a document and deserves its own tests.
 */
import { parseVisual } from "./answer-visuals.mjs";

/** Inline markers, longest-first so `**bold**` is never mistaken for two italics. */
const INLINE = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]*\]\([^)\s]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;

/**
 * Splits one line of text into styled spans.
 *
 * Returns a single text span for unstyled input rather than an empty array, because the renderer
 * should never have to special-case "this paragraph had no formatting".
 */
export function parseInline(line) {
  const source = typeof line === "string" ? line : "";
  if (!source) return [];
  const spans = [];
  let cursor = 0;
  for (const match of source.matchAll(INLINE)) {
    const token = match[0];
    if (match.index > cursor) spans.push({ kind: "text", text: source.slice(cursor, match.index) });
    cursor = match.index + token.length;
    if (token.startsWith("**") || token.startsWith("__")) {
      spans.push({ kind: "bold", text: token.slice(2, -2) });
    } else if (token.startsWith("`")) {
      spans.push({ kind: "code", text: token.slice(1, -1) });
    } else if (token.startsWith("[")) {
      const split = token.indexOf("](");
      spans.push({ kind: "link", text: token.slice(1, split), href: token.slice(split + 2, -1) });
    } else {
      spans.push({ kind: "italic", text: token.slice(1, -1) });
    }
  }
  if (cursor < source.length) spans.push({ kind: "text", text: source.slice(cursor) });
  return spans;
}

/**
 * `| a | b |` → `["a", "b"]`. The outer pipes are optional in GFM, so they are trimmed if present.
 *
 * Exported because the renderer splits a row lazily, inside a memoised component, rather than reading
 * the pre-parsed cells — see the `sources` note on the table block below.
 */
export const cells = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

/** True for `|---|:--:|`, the line that makes the row above it a header rather than a paragraph. */
const isTableRule = (line) =>
  typeof line === "string" && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;

/**
 * Splits a partly-written answer into the part that can no longer change and the part still arriving.
 *
 * This exists for one reason: while an answer streams, the naive render re-renders the whole thing on
 * every frame. Reconciling a growing forty-row table sixty times a second is what made typing feel
 * laggy — and the lag got worse the longer the answer, because the settled part being redrawn kept
 * growing. Parsing was never the cost; redrawing finished output was.
 *
 * A blank line is the boundary, because every block this parser produces is terminated by one. Once
 * a blank line has landed, nothing above it can be revised by later characters — a table cannot gain
 * another row, a paragraph cannot gain another sentence.
 *
 * The one exception is a fence, which legitimately contains blank lines. A split inside an open
 * ```chart would cut a JSON spec in half and render both halves as garbage, so fences are tracked and
 * a blank line inside one is not a boundary.
 *
 * What this does NOT help with, and it is the case that matters most: a table has no blank line in
 * it, so a growing hundred-row table settles nothing at all — measured at 68 characters settled
 * against 28,642 still arriving. Long lists are the answers this feature exists to produce, so the
 * boundary that actually carries the load is the per-row one in `Markdown.tsx`, and this handles the
 * prose around it.
 */
export function splitSettled(markdown) {
  const source = String(markdown ?? "").replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  let fenced = false;
  let boundary = 0;
  // The final line is excluded: it is the one currently being written, and a trailing "\n" would
  // otherwise make an unfinished line look settled.
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (/^\s*(```|~~~)/.test(lines[index])) fenced = !fenced;
    else if (!fenced && !lines[index].trim()) boundary = index + 1;
  }
  if (!boundary) return { settled: "", tail: source };
  return { settled: lines.slice(0, boundary).join("\n"), tail: lines.slice(boundary).join("\n") };
}

/**
 * Parses markdown into a flat list of blocks.
 *
 * Flat rather than a tree because nothing the model emits nests beyond an indented bullet, and list
 * items carry their own `depth` for that. A real document model would be more correct and would earn
 * none of it back here.
 */
export function parseBlocks(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let quoted = [];

  /**
   * Runs of lines accumulate until something else starts, so a soft-wrapped sentence stays one block
   * and a two-line callout stays one callout. A blank line flushes both, which is what makes two
   * findings quoted one after the other stay two findings.
   */
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join(" ")) });
    if (quoted.length) blocks.push({ kind: "callout", spans: parseInline(quoted.join(" ")) });
    paragraph = [];
    quoted = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (!line.trim()) {
      flush();
      continue;
    }

    // Fenced code, taken verbatim to the closing fence or the end of the answer. An unclosed fence
    // is common in a truncated reply and must not swallow the rest as an error.
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      flush();
      const body = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      const language = fence[1] || "";
      const source = body.join("\n");
      // Whether the closing fence actually arrived. Mid-stream it has not, and a half-written chart
      // spec is invalid JSON, so the renderer needs to tell "this is code" from "this is not finished
      // yet" — otherwise the reader watches raw JSON scroll past before it snaps into a chart.
      const closed = index < lines.length;
      // `export` is a directive rather than a visual: it turns into download buttons for the answer it
      // ends. Only once the closing fence has landed, because a button that appears mid-word and then
      // changes what it offers is worse than one that appears a second late.
      if (language === "export" && closed) {
        const formats = [...new Set(source.toLowerCase().match(/csv|pdf/g) ?? [])];
        if (formats.length) {
          blocks.push({ kind: "export", formats });
          continue;
        }
      }
      // A `chart` or `stats` fence is a visual; anything else, or a visual we cannot read, stays code.
      // Falling back rather than failing means a malformed spec shows as visible JSON instead of
      // taking the answer down with it.
      const visual = parseVisual(language, source);
      blocks.push(visual ?? { kind: "code", language, text: source, closed });
      continue;
    }

    // Blockquotes carry the one-line finding the model wants read first, so they render as a callout
    // rather than as indented prose.
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      if (paragraph.length) flush();
      quoted.push(quote[1].trim());
      continue;
    }
    if (quoted.length) flush();

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, spans: parseInline(heading[2].trim()) });
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ kind: "rule" });
      continue;
    }

    // A table needs the rule line underneath it. Without that check a line of prose containing a
    // pipe becomes a one-column table, which looks far worse than the pipe would have.
    if (line.includes("|") && isTableRule(lines[index + 1])) {
      flush();
      const head = cells(line).map(parseInline);
      const rows = [];
      // The raw line for each row, kept beside the parsed cells purely as a memo key for the
      // renderer. A table is the one block that grows a row at a time while an answer streams, and
      // it is also the one with no blank line in it — so the settled/tail split cannot help here and
      // the boundary has to be per row. `rows` is what the CSV export reads; `sources` is what tells
      // React that row 47 has not changed since the last frame.
      const sources = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(cells(lines[index]).map(parseInline));
        sources.push(lines[index]);
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "table", head, rows, sources });
      continue;
    }

    const item = line.match(LIST_ITEM);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const depth = Math.min(Math.floor(item[1].length / 2), 2);
      // Flushed before the run is inspected, so a paragraph sitting between two lists breaks them
      // apart instead of the second silently joining the first.
      flush();
      // `source` is the memo key, for the same reason table rows carry one: a long list grows an item
      // at a time and every item above the new one is unchanged.
      const entry = { depth, spans: parseInline(item[3]), source: item[3] };
      const open = blocks.at(-1);
      if (open && open.kind === "list" && open.ordered === ordered) open.items.push(entry);
      else blocks.push({ kind: "list", ordered, items: [entry] });
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

/** The plain text of a span run, used by the CSV export and for copying an answer out. */
export const spansToText = (spans) =>
  (Array.isArray(spans) ? spans : []).map((span) => String(span?.text ?? "")).join("");
