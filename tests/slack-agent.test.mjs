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
  botParticipated,
  cleanMention,
  inlineToMrkdwn,
  progressLabel,
  progressText,
  threadToTurns,
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

test("a tool is described as a source, not by its function name", () => {
  assert.equal(progressLabel("heyreach_campaign_metrics"), "Checking campaign analytics");
  assert.equal(progressLabel("brain_search"), "Searching the QC Brain");
  assert.equal(progressLabel("airtable_create_records"), "Adding rows to Airtable");
});

test("a client-scoped lookup names the client", () => {
  assert.equal(progressLabel("client_summary", { client: "Cotool" }), "Reading Cotool's context");
  assert.equal(progressLabel("search_leads", { client: "Willow" }), "Searching leads · Willow");
});

test("an unknown tool still gets a readable label rather than a blank", () => {
  assert.equal(progressLabel("some_new_tool"), "some new tool");
  assert.equal(progressLabel(""), "Working");
});

test("the progress message marks finished steps done and the running one as pending", () => {
  const out = progressText([
    { label: "Listing clients", status: "ok" },
    { label: "Checking campaign analytics", status: "fail" },
    { label: "Searching the QC Brain", status: "doing" },
  ]);
  assert.ok(out.includes("Looking into it"));
  assert.ok(out.includes("✓  Listing clients"));
  assert.ok(out.includes("⚠️  Checking campaign analytics"));
  assert.ok(out.includes("⏳  Searching the QC Brain"));
});

test("the progress message shows only the most recent steps and drops the rest silently", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `step ${i}`, status: "ok" }));
  const out = progressText(many);
  assert.ok(!out.includes("earlier"), "older steps roll off without a running count in the header");
  assert.ok(out.includes("step 11"), "the newest step is shown");
  assert.ok(!out.includes("step 0"), "the oldest step has rolled off");
});

test("a heartbeat stamps the running time so two edits differ even when the steps have not", () => {
  const steps = [{ label: "Listing clients", status: "ok" }];
  const at5 = progressText(steps, { elapsedMs: 5_000 });
  const at12 = progressText(steps, { elapsedMs: 12_400 });
  assert.ok(at5.includes("(5s)"), "the elapsed seconds are shown");
  assert.ok(at12.includes("(12s)"), "and rounded, so the number moves");
  assert.notEqual(at5, at12, "a later heartbeat is a different string, so Slack does not reject it as a no-op");
});

test("once every step is done the heartbeat says it is still working, so a frozen list does not read as a crash", () => {
  const out = progressText([{ label: "Reading the QC Brain", status: "ok" }], { elapsedMs: 40_000 });
  assert.ok(out.includes("Still working on it"), "the composing gap after the last tool needs a sign of life");
});

test("while a step is still running the heartbeat adds no second working line", () => {
  const out = progressText([{ label: "Searching leads", status: "doing" }], { elapsedMs: 8_000 });
  assert.ok(out.includes("⏳  Searching leads"), "the running step already carries the hourglass");
  assert.ok(!out.includes("Still working on it"), "so a redundant footer would just be noise");
});

test("with no elapsed given the message is unchanged — no clock, no working line", () => {
  const out = progressText([{ label: "Listing clients", status: "ok" }]);
  assert.ok(!out.includes("(0s)") && !/\(\d+s\)/.test(out), "no clock without an elapsed figure");
  assert.ok(!out.includes("Still working on it"), "and no heartbeat footer");
});

/** The bot is stamped either with this user id or this bot id on any post it wrote. */
const IDENTITY = { userId: "U123BOT", botId: "B123BOT" };

test("the bot counts as a participant whether Slack stamped its user id or its bot id", () => {
  assert.equal(botParticipated([{ author: "U9HUMAN", botId: "" }, { author: "U123BOT", botId: "" }], IDENTITY), true);
  assert.equal(botParticipated([{ author: "", botId: "B123BOT" }], IDENTITY), true);
});

test("a thread the bot has never spoken in is not one it has joined", () => {
  assert.equal(botParticipated([{ author: "U9HUMAN", botId: "" }, { author: "U9OTHER", botId: "" }], IDENTITY), false);
  assert.equal(botParticipated([], IDENTITY), false);
});

test("a thread becomes alternating user and assistant turns, with the bot's mention stripped from questions", () => {
  const posts = [
    { author: "U9HUMAN", botId: "", text: "<@U123BOT> how did Cotool do?" },
    { author: "U123BOT", botId: "", text: "It replied to 12 leads." },
    { author: "U9HUMAN", botId: "", text: "and Willow?" },
  ];
  assert.deepEqual(threadToTurns(posts, IDENTITY), [
    { role: "user", content: "how did Cotool do?" },
    { role: "assistant", content: "It replied to 12 leads." },
    { role: "user", content: "and Willow?" },
  ]);
});

test("two posts from the same side in a row are merged so no role repeats", () => {
  const posts = [
    { author: "U9A", botId: "", text: "first thing" },
    { author: "U9B", botId: "", text: "second thing" },
    { author: "", botId: "B123BOT", text: "on it" },
  ];
  assert.deepEqual(threadToTurns(posts, IDENTITY), [
    { role: "user", content: "first thing\n\nsecond thing" },
    { role: "assistant", content: "on it" },
  ]);
});

test("a thread that opens with the bot drops the lead assistant turns so it starts on a person", () => {
  const posts = [
    { author: "", botId: "B123BOT", text: "morning brief: Cotool is up" },
    { author: "U9HUMAN", botId: "", text: "<@U123BOT> why?" },
  ];
  assert.deepEqual(threadToTurns(posts, IDENTITY), [{ role: "user", content: "why?" }]);
});
