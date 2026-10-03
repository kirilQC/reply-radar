// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { humanReplies, pickExamples, bannedPhrases, voiceBlock, templateKey } from "../app/lib/reply-voice.ts";
import { stripDashLikeHyphens } from "../shared/no-dashes.mjs";

const at = (minute) => new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();
const msg = (conversationId, direction, body, minute, extra = {}) => ({ conversationId, direction, body, sentAt: at(minute), senderName: "Aman", campaignName: "US002", ...extra });

// Three leads got the same scripted opener; one answered and got a real reply.
const opener = (name) => `Hi ${name}, I'm building Unsiloed (YC), which turns complex financial documents into reliable data. Open to a chat?`;
const messages = [
  msg("c1", "outbound", opener("Upavan"), 1),
  msg("c1", "inbound", "Hi Aman! Would be happy to chat.", 5),
  msg("c1", "outbound", "Amazing, here's my cal, grab any slot that works", 9),
  msg("c2", "outbound", opener("Che"), 1),
  msg("c2", "inbound", "sure", 4),
  msg("c2", "outbound", opener("Che"), 6), // a scripted step that happens to land after a reply
  msg("c3", "outbound", opener("Pooneh"), 1),
  msg("c4", "outbound", opener("Ash"), 1),
  msg("c4", "inbound", "what is it exactly?", 3, { campaignName: "OTHER" }),
  msg("c4", "outbound", "We parse messy PDFs into clean tables for your models. Worth 15 min?", 7, { campaignName: "OTHER", senderName: "Raj" }),
];
const names = new Map([["c1", "Upavan Gupta"], ["c2", "Che Guan"], ["c3", "Pooneh X"], ["c4", "Ash Y"]]);

test("only outbound messages answering an inbound count, and templates never do", () => {
  const replies = humanReplies(messages, names);
  assert.deepEqual(replies.map((r) => r.body).sort(), [
    "Amazing, here's my cal, grab any slot that works",
    "We parse messy PDFs into clean tables for your models. Worth 15 min?",
  ].sort());
  const cal = replies.find((r) => r.body.startsWith("Amazing"));
  assert.equal(cal.inbound, "Hi Aman! Would be happy to chat.");
  assert.equal(cal.leadName, "Upavan Gupta");
});

test("the conversation being drafted is never its own example", () => {
  assert.equal(humanReplies(messages, names, "c1").some((r) => r.body.startsWith("Amazing")), false);
});

test("same campaign and same sender rank first", () => {
  const picked = pickExamples(humanReplies(messages, names), { campaignName: "US002", senderName: "Aman" });
  assert.equal(picked[0].body.startsWith("Amazing"), true);
  const other = pickExamples(humanReplies(messages, names), { campaignName: "OTHER", senderName: "Raj" });
  assert.equal(other[0].senderName, "Raj");
});

test("a template matches itself across names", () => {
  assert.equal(templateKey(opener("Upavan"), "Upavan Gupta"), templateKey(opener("Che"), "Che Guan"));
});

test("banned phrases exclude what the team really says", () => {
  const banned = bannedPhrases([{ body: "Totally understand, no rush", inbound: "", senderName: "", leadName: "", campaignName: "", sentAt: "" }]);
  assert.equal(banned.includes("totally understand"), false);
  assert.equal(banned.includes("valuable context"), true);
});

test("the voice block pairs each reply with what it answered and has no dashes", () => {
  const block = voiceBlock(
    [{ body: "we're in a feedback phase right now- if a call works lmk", inbound: "Thanks!", senderName: "Aman", leadName: "", campaignName: "", sentAt: "" }],
    "Unsiloed",
    "Aman",
  );
  assert.match(block, /Lead wrote: Thanks!\nWe replied \(Aman\): we're in a feedback phase right now, if a call works lmk/);
  assert.match(block, /writing as Aman/);
  assert.doesNotMatch(block, /[—–]/);
});

test("drafts lose every kind of dash but keep hyphenated words", () => {
  assert.equal(stripDashLikeHyphens("valuable context—and exactly why"), "valuable context, and exactly why");
  assert.equal(stripDashLikeHyphens("Sounds great - talk soon"), "Sounds great, talk soon");
  assert.equal(stripDashLikeHyphens("an LLM-ready follow-up"), "an LLM-ready follow-up");
  assert.equal(stripDashLikeHyphens("Monday 2–4pm"), "Monday 2 to 4pm");
});
