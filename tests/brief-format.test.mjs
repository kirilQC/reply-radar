// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The brief, un-Slacked, and the four ways that parse could quietly go wrong.
 *
 * The stored brief is the exact bytes Slack received, and the website reads them back into a document.
 * The failure mode is not a crash — it is a heading that renders as a section with nothing under it, a
 * warning that renders as a heading, a mention shown as its raw id, or a run of prose lines that the
 * model wrapped shown as one paragraph per line. Each of those is a thing a reader would notice and
 * nobody would report, so they are pinned here instead.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { parseSlackBrief, parseInline, recapPlainText, EMOJI, emojiGlyph } from "../app/lib/brief-format.ts";

/** The shape a real posted brief has: fenced centred headings, bullets indented four per level, a footer. */
const DIVIDER = "=".repeat(37);
const SAMPLE = [
  `${DIVIDER}`,
  ``,
  `                    *:signal_strength: _Active Campaigns_ :signal_strength:*`,
  ``,
  `${DIVIDER}`,
  ``,
  `Two campaigns are live and pacing.`,
  `• <@U012ABCDE> to send the new leads today`,
  `        • This is the accountability clause`,
  `:warning: New leads or a new campaign must be in motion today! :warning:`,
  ``,
  `${DIVIDER}`,
  ``,
  `                    *:hourglass: _Client Bottlenecks_ :hourglass:*`,
  ``,
  `${DIVIDER}`,
  ``,
  `Nothing is blocked.`,
].join("\n");

test("headings come back as headings, not as the section titles they wrap", () => {
  const blocks = parseSlackBrief(SAMPLE);
  const headings = blocks.filter((block) => block.type === "heading");
  assert.equal(headings.length, 2);
  assert.equal(headings[0].emoji, "signal_strength");
  assert.equal(headings[0].glyph, "📶");
  assert.equal(headings[0].title.map((node) => node.value ?? "").join(""), "Active Campaigns");
});

test("the runway warning stays a callout and is never mistaken for a heading", () => {
  const blocks = parseSlackBrief(SAMPLE);
  const callouts = blocks.filter((block) => block.type === "callout");
  assert.equal(callouts.length, 1);
  assert.equal(callouts[0].emoji, "warning");
  assert.equal(callouts[0].glyph, "⚠️");
  // The trailing mirror emoji is dropped; the text is the sentence between them.
  const text = callouts[0].children.map((node) => node.value ?? "").join("");
  assert.match(text, /New leads or a new campaign must be in motion today!/);
});

test("dividers are dropped entirely", () => {
  const blocks = parseSlackBrief(SAMPLE);
  const text = JSON.stringify(blocks);
  assert.ok(!text.includes("====="), "no divider text should survive into a block");
});

test("bullet indent becomes zero-based depth", () => {
  const blocks = parseSlackBrief(SAMPLE);
  const bullets = blocks.filter((block) => block.type === "bullet");
  assert.equal(bullets.length, 2);
  assert.equal(bullets[0].depth, 0, "four spaces is top level");
  assert.equal(bullets[1].depth, 1, "eight spaces is once nested");
});

test("mentions resolve to names, or fall back to the id when unknown", () => {
  const known = parseSlackBrief(SAMPLE, { U012ABCDE: "Kiril" });
  const bullet = known.find((block) => block.type === "bullet");
  const mention = bullet.children.find((node) => node.type === "mention");
  assert.equal(mention.name, "Kiril");

  const unknown = parseSlackBrief(SAMPLE);
  const bulletU = unknown.find((block) => block.type === "bullet");
  const mentionU = bulletU.children.find((node) => node.type === "mention");
  assert.equal(mentionU.name, "U012ABCDE", "an unmapped id is shown, not dropped");
});

test("wrapped prose lines fold into one paragraph", () => {
  const blocks = parseSlackBrief("A first line\nwrapped onto a second\n\nA new paragraph");
  const paragraphs = blocks.filter((block) => block.type === "paragraph");
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].children.map((node) => node.value ?? "").join(""), "A first line wrapped onto a second");
});

test("inline bold and italic nest rather than flatten", () => {
  const nodes = parseInline("*bold with _italic_ inside*");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "bold");
  const inner = nodes[0].children.find((node) => node.type === "italic");
  assert.ok(inner, "italic should nest inside bold");
});

test("a Slack link becomes a link with its label", () => {
  const nodes = parseInline("see <https://example.com|the report> now");
  const link = nodes.find((node) => node.type === "link");
  assert.equal(link.href, "https://example.com");
  assert.equal(link.label, "the report");
});

test("numbered items are recognised", () => {
  const blocks = parseSlackBrief("1. First thing\n2. Second thing");
  const numbered = blocks.filter((block) => block.type === "numbered");
  assert.equal(numbered.length, 2);
  assert.equal(numbered[0].number, 1);
});

test("an unknown shortcode is left visible rather than dropped", () => {
  assert.equal(emojiGlyph("not_a_real_emoji"), ":not_a_real_emoji:");
  assert.equal(EMOJI.signal_strength, "📶");
});

test("a stray delimiter with no partner stays literal text", () => {
  const nodes = parseInline("2 * 3 = 6");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].type, "text");
  assert.equal(nodes[0].value, "2 * 3 = 6");
});

/* ── The recap, flattened for a spreadsheet cell ────────────────────────────────────────────────── */

const RECAP = [
  `${DIVIDER}`,
  ``,
  `                    *:dart: _Action Items_ :dart:*`,
  ``,
  `${DIVIDER}`,
  ``,
  `1. <@U01> to *send the leads*`,
  `    • _agreed on the call_`,
  ``,
  `2. *Dana* to review the copy`,
].join("\n");

test("the plain-text recap drops every Slack marker the cell cannot render", () => {
  const text = recapPlainText(RECAP, { U01: "Kiril" });
  assert.ok(!text.includes("="), "the heading fences must be gone");
  assert.ok(!text.includes("*"), "single-asterisk bold must be stripped");
  assert.ok(!text.includes("_"), "underscore italics must be stripped");
  assert.ok(!text.includes("<@"), "raw mention codes must be resolved");
  assert.ok(!text.includes(":dart:"), "emoji shortcodes must not survive");
});

test("the plain-text recap keeps the words, the numbers and the names", () => {
  const text = recapPlainText(RECAP, { U01: "Kiril" });
  assert.match(text, /Action Items/);
  assert.match(text, /1\. Kiril to send the leads/);
  assert.match(text, /2\. Dana to review the copy/);
});

test("the plain-text recap keeps a blank line between items and glues the sub-bullet under its own", () => {
  const text = recapPlainText(RECAP, { U01: "Kiril" });
  // The detail clause sits directly under item one, no blank line before it.
  assert.match(text, /1\. Kiril to send the leads\n\s+• agreed on the call/);
  // A blank line separates one numbered item from the next.
  assert.match(text, /agreed on the call\n\n2\. Dana/);
});

test("an unmapped mention falls back to its id, visible rather than dropped", () => {
  const text = recapPlainText("1. <@U99> to do it");
  assert.match(text, /1\. U99 to do it/);
});
