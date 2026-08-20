// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The three things the Slack route gets wrong if these are wrong: it trusts a forged request, it hands
 * the model a question still wrapped in Slack's `<@U…>` syntax, or it posts an answer full of raw
 * markdown that reads as broken in chat. All three are pure string work, so they are driven here
 * directly rather than through the route, which cannot run without Slack, Anthropic and Supabase.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  cleanMention,
  inlineToMrkdwn,
  toSlackText,
  truncateForSlack,
  verifySlackSignature,
} from "../shared/slack-agent.mjs";

/** The signature Slack would send for this exact body and timestamp, so a valid request can be built. */
const sign = (secret, timestamp, body) =>
  `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;

test("a request signed with the right secret at the right time verifies", () => {
  const secret = "shhh";
  const now = 1_700_000_000;
  const body = '{"type":"event_callback"}';
  const ts = String(now);
  assert.equal(
    verifySlackSignature({ signingSecret: secret, timestamp: ts, body, signature: sign(secret, ts, body), now }),
    true,
  );
});

test("a request signed with the wrong secret is refused", () => {
  const now = 1_700_000_000;
  const body = '{"type":"event_callback"}';
  const ts = String(now);
  assert.equal(
    verifySlackSignature({ signingSecret: "real", timestamp: ts, body, signature: sign("forged", ts, body), now }),
    false,
  );
});

test("a validly signed but stale request is refused as a replay", () => {
  const secret = "shhh";
  const signedAt = 1_700_000_000;
  const body = "{}";
  const ts = String(signedAt);
  const signature = sign(secret, ts, body);
  // Six minutes later — outside the five-minute window.
  const now = signedAt + 6 * 60;
  assert.equal(verifySlackSignature({ signingSecret: secret, timestamp: ts, body, signature, now }), false);
});

test("the body has to match byte-for-byte — a re-serialised body fails", () => {
  const secret = "shhh";
  const now = 1_700_000_000;
  const ts = String(now);
  const original = '{"a":1,"b":2}';
  const reserialised = '{"a": 1, "b": 2}';
  const signature = sign(secret, ts, original);
  assert.equal(
    verifySlackSignature({ signingSecret: secret, timestamp: ts, body: reserialised, signature, now }),
    false,
  );
});

test("a signature of the wrong length is refused, not thrown", () => {
  const secret = "shhh";
  const now = 1_700_000_000;
  const ts = String(now);
  assert.equal(
    verifySlackSignature({ signingSecret: secret, timestamp: ts, body: "{}", signature: "v0=abc", now }),
    false,
  );
});

test("missing pieces are refused rather than crashing", () => {
  assert.equal(verifySlackSignature({ signingSecret: "", timestamp: "1", body: "{}", signature: "v0=x" }), false);
  assert.equal(verifySlackSignature({ signingSecret: "s", timestamp: "", body: "{}", signature: "v0=x" }), false);
  assert.equal(verifySlackSignature({ signingSecret: "s", timestamp: "1", body: "{}", signature: "" }), false);
  assert.equal(
    verifySlackSignature({ signingSecret: "s", timestamp: "notanumber", body: "{}", signature: "v0=x" }),
    false,
  );
});

test("the bot mention is stripped off the front of the question", () => {
  assert.equal(cleanMention("<@U123BOT> how did Cotool do this week?"), "how did Cotool do this week?");
});

test("channel mentions and Slack's special mentions are removed", () => {
  assert.equal(cleanMention("<@U1> ping <#C9|general> for <!here> now"), "ping for now");
});

test("a link keeps its label, and a bare link keeps its url", () => {
  assert.equal(cleanMention("see <https://x.co|the dashboard> now"), "see the dashboard now");
  assert.equal(cleanMention("open <https://x.co/path> please"), "open https://x.co/path please");
});

test("a mention with no question in it collapses to empty", () => {
  assert.equal(cleanMention("<@U123BOT>"), "");
  assert.equal(cleanMention("   <@U123BOT>   "), "");
});

test("bold and links become Slack mrkdwn", () => {
  assert.equal(inlineToMrkdwn("the **reply rate** is up"), "the *reply rate* is up");
  assert.equal(inlineToMrkdwn("__strong__ too"), "*strong* too");
  assert.equal(inlineToMrkdwn("see [the dash](https://x.co/d)"), "see <https://x.co/d|the dash>");
  assert.equal(inlineToMrkdwn("![alt](https://x.co/i.png) gone"), " gone");
});

test("visual fenced blocks are dropped, prose is kept", () => {
  const md = [
    "Cotool had a strong week.",
    "",
    "```stats",
    '{"replies": 12}',
    "```",
    "",
    "Reply rate 63%.",
  ].join("\n");
  const out = toSlackText(md);
  assert.ok(!out.includes("replies"), "the stats JSON should be gone");
  assert.ok(out.includes("Cotool had a strong week."));
  assert.ok(out.includes("Reply rate 63%."));
});

test("a markdown table becomes a fixed-width code block", () => {
  const md = ["| Campaign | Replies |", "|---|---|", "| CT50 | 12 |", "| CT005 | 35 |"].join("\n");
  const out = toSlackText(md);
  assert.ok(out.startsWith("```"), "the table must be wrapped in a code fence for Slack's monospace font");
  assert.ok(out.includes("Campaign"));
  assert.ok(out.includes("CT005"));
  assert.ok(!out.includes("|---|"), "the markdown separator row should not survive");
});

test("headings become bold and a real code block is left untouched", () => {
  const md = ["## Summary", "", "```js", "const x = **not bold here**;", "```"].join("\n");
  const out = toSlackText(md);
  assert.ok(out.includes("*Summary*"), "a heading has no Slack form, so it is bolded");
  assert.ok(out.includes("const x = **not bold here**;"), "content inside a real code fence is not rewritten");
});

test("a short answer is returned unchanged", () => {
  const answer = "Cotool replied to 12 leads this week.";
  assert.equal(truncateForSlack(answer), answer);
});

test("an over-long answer is cut and marked", () => {
  const answer = "x".repeat(40_000);
  const out = truncateForSlack(answer, 100);
  assert.ok(out.length < answer.length);
  assert.ok(out.includes("truncated for Slack"));
});

test("a cut that lands inside a code fence closes the fence before the marker", () => {
  const answer = "```\n" + "row\n".repeat(5000);
  const out = truncateForSlack(answer, 50);
  const fences = (out.match(/```/g) ?? []).length;
  assert.equal(fences % 2, 0, "every opened fence must be closed so the marker is not swallowed");
  assert.ok(out.includes("truncated for Slack"));
});
