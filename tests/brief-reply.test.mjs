// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The dangerous half of the brief-reply handler is pure, so it is driven here directly. The one failure
 * this feature must never have is a thread reply quietly replacing the brief the whole team reads with a
 * sentence, so the parse and the safety guard get the most coverage: a model that fences its JSON, a model
 * that returns prose, and an "edit" that is really a wipe all have to be handled without ever pushing a bad
 * body over the real message.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  MORNING_BRIEF,
  EOW_REPORT,
  briefReplySystemPrompt,
  briefReplyUserContent,
  parseBriefReplyOutput,
  briefEditIsSafe,
} from "../shared/brief-reply.mjs";

test("the morning-brief prompt tells the model to strike done items with tildes and to touch nothing else", () => {
  const prompt = briefReplySystemPrompt(MORNING_BRIEF);
  assert.ok(prompt.includes("~tildes~"), "the strikethrough syntax is spelled out");
  assert.ok(/strike only that item/i.test(prompt), "only the one item is struck");
  assert.ok(/morning brief/i.test(prompt), "the prompt knows which document it is editing");
});

test("the EOW prompt tells the model to keep the client-ready style and only change what was asked", () => {
  const prompt = briefReplySystemPrompt(EOW_REPORT);
  assert.ok(/End-of-Week/i.test(prompt), "the prompt knows it is the weekly report");
  assert.ok(/client-ready/i.test(prompt), "the formal style is preserved");
  assert.ok(/sign-off/i.test(prompt), "the closing line is protected");
});

test("an unknown automation is never rewritten from a reply", () => {
  const prompt = briefReplySystemPrompt("call_analysis");
  assert.ok(prompt.includes('"updatedBody": null'), "it is told to always return no edit");
});

test("every prompt asks for strict JSON and forbids inventing facts", () => {
  for (const automation of [MORNING_BRIEF, EOW_REPORT, "other"]) {
    const prompt = briefReplySystemPrompt(automation);
    assert.ok(prompt.includes('"reply"') && prompt.includes('"updatedBody"'), `${automation}: JSON shape stated`);
    assert.ok(/never invent/i.test(prompt), `${automation}: inventing is forbidden`);
  }
});

test("the user content carries the posted message and the reply, and asks for JSON only", () => {
  const content = briefReplyUserContent({ body: "the brief body", replies: ["we already did CT003", "thanks"] });
  assert.ok(content.includes("the brief body"), "the posted message is included");
  assert.ok(content.includes("- we already did CT003"), "each reply is a bullet");
  assert.ok(content.includes("- thanks"), "every reply is included");
  assert.ok(/Return only the JSON object/i.test(content), "the model is told to return JSON only");
});

test("user content survives missing or junk inputs without throwing", () => {
  const content = briefReplyUserContent({});
  assert.ok(content.includes("(no reply text could be read)"), "an empty reply set is stated plainly");
  const content2 = briefReplyUserContent({ body: "  hi  ", replies: ["", "  ", "real"] });
  assert.ok(content2.includes("- real"), "blank replies are dropped, real ones kept");
  assert.ok(!content2.includes("-  \n"), "blank replies do not become empty bullets");
});

test("a bare JSON object parses into reply and edit", () => {
  const out = parseBriefReplyOutput('{"reply": "struck it", "updatedBody": "the full new body"}');
  assert.equal(out.reply, "struck it");
  assert.equal(out.updatedBody, "the full new body");
});

test("a fenced or prose-wrapped JSON object is still recovered", () => {
  const out = parseBriefReplyOutput('Sure!\n```json\n{"reply": "done", "updatedBody": null}\n```');
  assert.equal(out.reply, "done");
  assert.equal(out.updatedBody, null);
});

test("output that will not parse is treated as the whole reply with no edit", () => {
  const out = parseBriefReplyOutput("I could not do that.");
  assert.equal(out.reply, "I could not do that.");
  assert.equal(out.updatedBody, null);
});

test("updatedBody is only honoured when it is a non-empty string", () => {
  assert.equal(parseBriefReplyOutput('{"reply": "x", "updatedBody": ""}').updatedBody, null);
  assert.equal(parseBriefReplyOutput('{"reply": "x", "updatedBody": 5}').updatedBody, null);
  assert.equal(parseBriefReplyOutput('{"reply": "x", "updatedBody": "   "}').updatedBody, null);
});

test("a safe edit is one that changes the message without gutting it", () => {
  const original = "line one\nline two\nline three that is fairly long so the doc has some length to it";
  const struck = "line one\n~line two~\nline three that is fairly long so the doc has some length to it";
  assert.equal(briefEditIsSafe(original, struck), true, "a strikethrough only adds characters, so it is safe");
});

test("a wipe, an identical edit, an empty edit, and a non-string are all refused", () => {
  const original = "a fairly long brief with several lines so that a one-line replacement is clearly a wipe of it all";
  assert.equal(briefEditIsSafe(original, "done"), false, "collapsing to a sentence is refused");
  assert.equal(briefEditIsSafe(original, original), false, "an identical body is not an edit");
  assert.equal(briefEditIsSafe(original, "   "), false, "an empty body is refused");
  assert.equal(briefEditIsSafe(original, null), false, "a null body is refused");
});
