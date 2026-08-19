// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The brief, un-Slacked.
 *
 * A posted brief is stored exactly as Slack renders it: `*bold*`, `_italic_`, `:emoji:` shortcodes,
 * `<@U012ABCDE>` mention codes, `•` bullets indented four spaces per level, and every heading fenced
 * top and bottom by a rule of `=`. That is the right thing to keep — it is the exact bytes that went to
 * Slack, and a preview that had prettified them would have hidden the one thing worth checking. But on
 * the website the same bytes read as source code, and the point of looking at a brief on a screen with a
 * real font is to read it, not to proofread its markup. So this turns that stored string back into a
 * small block model a component can render as a document: headings as headings, bullets as a list, the
 * fences dropped, the shortcodes resolved to glyphs, and `<@U…>` shown as the person's name.
 *
 * Pure and import-free on purpose: it is the half of the brief that can be asserted against directly in a
 * test, with no Slack, no database and no clock. The rendering — which HTML, which classes — lives in the
 * component; this file only decides *what* each line is.
 */

/**
 * The shortcodes the brief actually uses, mapped to the glyph a browser can show without a Slack sprite.
 *
 * Only the ones the model is told to use plus the ones the footer and header add, because an exhaustive
 * emoji table is a dependency in all but name and would rot the first time Slack renamed one. Anything
 * not here is left as its `:shortcode:` text — visible, ugly, and therefore reported rather than silently
 * dropped, which is the same bargain the rest of this codebase makes with things it did not expect.
 */
export const EMOJI: Record<string, string> = {
  signal_strength: "📶",
  hourglass: "⌛",
  hourglass_flowing_sand: "⏳",
  warning: "⚠️",
  coffee: "☕",
  speech_balloon: "💬",
  page_facing_up: "📄",
  "male-technologist": "👨‍💻",
  man_technologist: "👨‍💻",
  "female-technologist": "👩‍💻",
  woman_technologist: "👩‍💻",
  handshake: "🤝",
  moneybag: "💰",
  dart: "🎯",
  rocket: "🚀",
  fire: "🔥",
  chart_with_upwards_trend: "📈",
  calendar: "📅",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  bell: "🔔",
  eyes: "👀",
  pushpin: "📌",
  bulb: "💡",
  tada: "🎉",
};

/** The glyph for a shortcode, or the shortcode itself when it is one we do not carry. */
export function emojiGlyph(name: string): string {
  return EMOJI[name] ?? `:${name}:`;
}

/** A run of inline content: text with bold/italic/emoji/mention/link spans threaded through it. */
export type InlineNode =
  | { type: "text"; value: string }
  | { type: "bold"; children: InlineNode[] }
  | { type: "italic"; children: InlineNode[] }
  | { type: "emoji"; name: string; glyph: string }
  | { type: "mention"; id: string; name: string }
  | { type: "link"; href: string; label: string };

/** One structural line of the brief, already told apart from its neighbours. */
export type BriefBlock =
  | { type: "heading"; emoji: string; glyph: string; title: InlineNode[] }
  | { type: "callout"; emoji: string; glyph: string; children: InlineNode[] }
  | { type: "bullet"; depth: number; children: InlineNode[] }
  | { type: "numbered"; number: number; children: InlineNode[] }
  | { type: "paragraph"; children: InlineNode[] };

/**
 * A heading line — `*:emoji: _Title_ :emoji:*` — split into its emoji and its words.
 *
 * The same shape `briefFraming` matches on the way out, deliberately: the underscores are what tell a
 * heading apart from the runway warning, which is also emoji-word-emoji but carries no italics. Get this
 * wrong the other way and the single most urgent line in the brief renders as a section title with
 * nothing under it.
 */
function headingParts(line: string): { emoji: string; title: string } | null {
  const match = /^\s*\*?\s*:([a-z0-9_+-]+):\s+_([^_]+)_\s+:[a-z0-9_+-]+:\s*\*?\s*$/i.exec(line);
  if (!match) return null;
  return { emoji: match[1], title: match[2].trim() };
}

/**
 * A callout line — `:emoji: some words :emoji:` with no italics — split into its emoji and its words.
 *
 * Covers two lines that look identical and read identically: the runway warning inside a section, and
 * the Monday/Friday reminder fenced at the foot. Both are an emoji, a sentence, and the same emoji again;
 * on the page both become one boxed line with the glyph as its mark. The trailing duplicate is dropped —
 * on a wall of proportional text the mirrored emoji is decoration, and the leading one already carries it.
 */
function calloutParts(line: string): { emoji: string; text: string } | null {
  const match = /^\s*:([a-z0-9_+-]+):\s+(.+?)\s+:[a-z0-9_+-]+:\s*$/i.exec(line);
  if (!match) return null;
  return { emoji: match[1], text: match[2].trim() };
}

/** A rule the framing drew round a heading. Any run of three or more equals signs, since the width is ours. */
function isDivider(line: string): boolean {
  return /^\s*={3,}\s*$/.test(line);
}

/**
 * A line of Slack mrkdwn as a tree of inline spans.
 *
 * Recursive on the delimiters rather than a single pass of toggles, so `*a _b_ c*` nests instead of
 * flattening. The four openers are checked in the order that makes each unambiguous: an angle bracket is
 * only ever a mention or a link, a colon only ever the start of a shortcode, and only then are `*` and `_`
 * read as emphasis. A stray delimiter with no partner falls through to literal text, which is what a
 * reader would assume it was anyway.
 */
export function parseInline(text: string, mentions: Record<string, string> = {}): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) nodes.push({ type: "text", value: buffer });
    buffer = "";
  };

  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const char = text[i];

    if (char === "<") {
      const close = text.indexOf(">", i);
      if (close > i) {
        const inner = text.slice(i + 1, close);
        if (inner.startsWith("@")) {
          flush();
          const id = inner.slice(1).split("|")[0];
          nodes.push({ type: "mention", id, name: mentions[id] || id });
          i = close + 1;
          continue;
        }
        if (/^(https?:\/\/|mailto:)/i.test(inner)) {
          flush();
          const bar = inner.indexOf("|");
          const href = bar === -1 ? inner : inner.slice(0, bar);
          const label = bar === -1 ? inner : inner.slice(bar + 1);
          nodes.push({ type: "link", href, label: label || href });
          i = close + 1;
          continue;
        }
      }
    }

    if (char === ":") {
      const emoji = /^:([a-z0-9_+-]+):/i.exec(rest);
      if (emoji) {
        flush();
        nodes.push({ type: "emoji", name: emoji[1], glyph: emojiGlyph(emoji[1]) });
        i += emoji[0].length;
        continue;
      }
    }

    if (char === "*") {
      const end = text.indexOf("*", i + 1);
      if (end > i + 1) {
        flush();
        nodes.push({ type: "bold", children: parseInline(text.slice(i + 1, end), mentions) });
        i = end + 1;
        continue;
      }
    }

    if (char === "_") {
      const end = text.indexOf("_", i + 1);
      if (end > i + 1) {
        flush();
        nodes.push({ type: "italic", children: parseInline(text.slice(i + 1, end), mentions) });
        i = end + 1;
        continue;
      }
    }

    buffer += char;
    i += 1;
  }

  flush();
  return nodes;
}

/**
 * The stored brief as a list of blocks, ready to render.
 *
 * One pass, line by line. Rules are dropped, blank lines end a paragraph, and each non-blank line is
 * asked in turn whether it is a heading, a callout, a bullet or a number before it is allowed to be plain
 * prose — heading before callout because a heading would also pass the callout test, bullet and number
 * before prose for the same reason. Consecutive prose lines are joined with a space rather than kept as
 * separate blocks, because the model wraps a paragraph across lines and on a real font those are one
 * paragraph, not several.
 *
 * `mentions` maps `U…` ids to names; a brief carries the codes and nothing else, so without the map every
 * `<@U…>` would render as its raw id. Missing from the map falls back to the id, which is wrong but
 * visible, and a visible wrong name gets fixed where a silently dropped mention does not.
 */
export function parseSlackBrief(body: string, mentions: Record<string, string> = {}): BriefBlock[] {
  const lines = String(body ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks: BriefBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ type: "paragraph", children: parseInline(text, mentions) });
    paragraph = [];
  };

  for (const line of lines) {
    if (isDivider(line)) continue;
    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = headingParts(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", emoji: heading.emoji, glyph: emojiGlyph(heading.emoji), title: parseInline(heading.title, mentions) });
      continue;
    }

    const callout = calloutParts(line);
    if (callout) {
      flushParagraph();
      blocks.push({ type: "callout", emoji: callout.emoji, glyph: emojiGlyph(callout.emoji), children: parseInline(callout.text, mentions) });
      continue;
    }

    const bullet = /^(\s*)•\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      // Four spaces per level on the way out, so the first bullet sits at four and the accountability
      // clause under it at eight. Here that is undone to a zero-based depth: four → top level, eight →
      // once nested. Rounded rather than divided cleanly because a stray space should not drop a level.
      const depth = Math.max(0, Math.round(bullet[1].length / 4) - 1);
      blocks.push({ type: "bullet", depth, children: parseInline(bullet[2].trim(), mentions) });
      continue;
    }

    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      blocks.push({ type: "numbered", number: Number(numbered[1]), children: parseInline(numbered[2].trim(), mentions) });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}

/**
 * The same stored brief, flattened to plain text for a place Slack mrkdwn only reads as noise.
 *
 * The Airtable recap cell is the one this exists for. A recap posted to Slack is stored as the exact bytes
 * that went out — `*bold*`, `_italic_`, `<@U012ABCDE>` codes, `:emoji:` shortcodes, and a rule of `=`
 * fencing every heading — which is right in Slack and a wall of markup in a spreadsheet cell, where nothing
 * renders it. So this reuses the same block parse the website does and reads it back out as text: a heading
 * becomes its words, a mention becomes the person's name, the fences and the emphasis marks are dropped,
 * and one blank line is kept between items so the list still reads as a list. The sub-bullet stays glued
 * under the item it belongs to, indented, with no blank line before it.
 *
 * `mentions` maps `U…` ids to names, the same map the website renders with; without it a `<@U…>` falls
 * back to its raw id, which is wrong but visible rather than silently dropped.
 */
export function recapPlainText(body: string, mentions: Record<string, string> = {}): string {
  const inline = (nodes: InlineNode[]): string =>
    nodes
      .map((node) => {
        switch (node.type) {
          case "text":
            return node.value;
          case "bold":
          case "italic":
            return inline(node.children);
          case "emoji":
            return node.glyph;
          case "mention":
            return node.name;
          case "link":
            return node.label;
        }
      })
      .join("");

  const lines: string[] = [];
  for (const block of parseSlackBrief(body, mentions)) {
    if (block.type === "bullet") {
      lines.push(`${"  ".repeat(block.depth + 1)}• ${inline(block.children)}`);
      continue;
    }
    if (lines.length) lines.push("");
    if (block.type === "heading") lines.push(inline(block.title));
    else if (block.type === "numbered") lines.push(`${block.number}. ${inline(block.children)}`);
    else lines.push(inline(block.children));
  }
  return lines.join("\n").trim();
}
