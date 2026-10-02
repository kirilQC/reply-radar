// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * What leaves a tool call: no secrets at any depth, never more than ~100 KB, and nothing cut without a
 * marker the model can see. And what leaves for Slack: every line of a long answer, in sections Slack
 * will accept, with code fences closed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeSelect, capToolResult, redact, RESULT_CAP } from "../app/lib/assistant-data.ts";
import { answerToBlocks, chunkText } from "../shared/slack-blocks.mjs";

test("secrets are stripped from embedded rows, at any depth", () => {
  const row = {
    id: "c1",
    rr_workspaces: { name: "Willow", heyreach_api_key_ciphertext: "enc:abc", clay_dnc_webhook_url: "" },
    rr_leads: [{ name: "Ada", nested: { slack_bot_token: "xoxb-1" } }],
  };
  const out = redact(row);
  assert.equal(out.rr_workspaces.name, "Willow");
  assert.equal(out.rr_workspaces.heyreach_api_key_ciphertext, undefined);
  assert.equal(out.rr_workspaces.has_heyreach_api_key_ciphertext, true);
  assert.equal(out.rr_workspaces.has_clay_dnc_webhook_url, false);
  assert.equal(out.rr_leads[0].nested.slack_bot_token, undefined);
  assert.doesNotMatch(JSON.stringify(out), /enc:abc|xoxb-1/);
});

test("an embedded select cannot reach workspace credentials", () => {
  assert.throws(() => assertSafeSelect("id,rr_workspaces(*)"), /columns named/);
  assert.throws(() => assertSafeSelect("id,ws:rr_workspaces!fk(name,*)"), /columns named/);
  assert.throws(() => assertSafeSelect("id,rr_workspaces(clay_dnc_webhook_url)"), /secret/);
  assert.throws(() => assertSafeSelect("id,k:heyreach_api_key_ciphertext"), /secret/);
  assert.doesNotThrow(() => assertSafeSelect("id,rr_workspaces(name,slug)"));
  assert.doesNotThrow(() => assertSafeSelect("*"));
  assert.doesNotThrow(() => assertSafeSelect("id,first_name,rr_conversations(sentiment,campaign_name)"));
});

test("a small result is sent unchanged", () => {
  const value = { rows: [{ a: 1 }], total: 1 };
  assert.equal(capToolResult(value), JSON.stringify(value));
});

test("bulky fields go first, with a note saying so", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ name: `Lead ${i}`, raw_data: { blob: "x".repeat(4000) } }));
  const out = capToolResult({ table: "rr_leads", rows });
  assert.ok(out.length <= RESULT_CAP);
  const parsed = JSON.parse(out);
  assert.equal(parsed.rows.length, 50, "every row survives once raw_data is gone");
  assert.match(parsed.rows[0].raw_data, /omitted to fit/);
  assert.match(parsed.resultTruncated, /raw_data/);
});

test("a list too long even when slimmed is cut to what fits, and says it is incomplete", () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ name: `Lead ${i}`, summary: "y".repeat(1500) }));
  const out = capToolResult({ leads: rows, leadsTotal: 300 });
  assert.ok(out.length <= RESULT_CAP);
  const parsed = JSON.parse(out);
  assert.ok(parsed.leads.length > 0 && parsed.leads.length < 300);
  assert.match(parsed.resultTruncated, new RegExp(`first ${parsed.leads.length} of 300`));
  assert.match(parsed.resultTruncated, /INCOMPLETE/);
});

test("a single huge value is hard-cut with an explicit marker", () => {
  // No list to shorten: one object with two hundred fields just under the long-string limit.
  const blob = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "w".repeat(1999)]));
  const out = capToolResult({ blob });
  assert.ok(out.length <= RESULT_CAP);
  assert.match(out, /RESULT TRUNCATED/);
});

test("long text is split at line boundaries with nothing dropped", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}: ${"word ".repeat(10)}`);
  const chunks = chunkText(lines.join("\n"), 2900);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.length <= 2900));
  assert.deepEqual(chunks.join("\n").split("\n"), lines, "every line, whole and in order");
});

test("a single overlong line is carried on, not cut", () => {
  const line = "word ".repeat(1500).trim();
  const chunks = chunkText(line, 2900);
  assert.ok(chunks.every((chunk) => chunk.length <= 2900));
  assert.equal(chunks.join(" "), line);
});

test("a long answer becomes several sections and a long code block keeps its fences", () => {
  const paragraph = Array.from({ length: 120 }, (_, i) => `Detail line ${i} about the campaign.`).join("\n");
  const code = Array.from({ length: 150 }, (_, i) => `row ${i} | ${"v".repeat(20)}`).join("\n");
  const { blocks } = answerToBlocks(`**Willow is up this week.**\n\n${paragraph}\n\n\`\`\`\n${code}\n\`\`\``);
  assert.ok(blocks, "still blocks");
  const texts = blocks.filter((b) => b.type === "section" && b.text).map((b) => b.text.text);
  assert.ok(texts.every((t) => t.length <= 3000), "Slack's section limit");
  assert.ok(texts.join("\n").includes("Detail line 119 about the campaign."), "the end of the paragraph survives");
  const fenced = texts.filter((t) => t.startsWith("```"));
  assert.ok(fenced.length > 1, "the code block spans several sections");
  assert.ok(fenced.every((t) => t.endsWith("```")), "each one closes its fence");
  assert.ok(fenced.join("\n").includes("row 149 |"), "the last code line survives");
});

test("an answer that would need more than 48 blocks falls back to plain text", () => {
  const huge = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}: ${"text ".repeat(700)}`).join("\n\n");
  const { blocks, text } = answerToBlocks(`**Big.**\n\n${huge}`);
  assert.equal(blocks, null);
  assert.ok(text.length > 0);
});
