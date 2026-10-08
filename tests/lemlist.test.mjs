// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { lemlistBody } from "../shared/lemlist-text.mjs";

test("a LinkedIn reply's words come from `text` (lemlist leaves `message` empty for LinkedIn)", () => {
  assert.equal(lemlistBody({ type: "linkedinReplied", text: "Sure, happy to chat next week." }, "inbound"), "Sure, happy to chat next week.");
  assert.equal(lemlistBody({ type: "linkedinSent", text: "Hey Deidre, quick one" }, "outbound"), "Hey Deidre, quick one");
});

test("a LinkedIn reply that is only a link is kept (no email signature cleaning on LinkedIn)", () => {
  assert.equal(lemlistBody({ type: "linkedinReplied", text: "https://calendly.com/someone/30min" }, "inbound"), "https://calendly.com/someone/30min");
});

test("an email reply drops the quoted thread lemlist keeps inside its HTML", () => {
  const html = '<div dir="ltr">Yes, Thursday works.</div><div class="gmail_quote"><div>On Tue, Kiril wrote:</div><blockquote>Our pitch</blockquote></div>';
  assert.equal(lemlistBody({ type: "emailsReplied", message: html }, "inbound"), "Yes, Thursday works.");
});

test("whichever of message and text is filled is used", () => {
  assert.equal(lemlistBody({ type: "linkedinSent", message: "", text: "From text" }, "outbound"), "From text");
  assert.equal(lemlistBody({ type: "emailsSent", message: "<p>From message</p>" }, "outbound"), "From message");
});
