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

import { readFileSync } from "node:fs";
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("HeyReach's analytics cleanup never deletes lemlist's stored figures", () => {
  const worker = source("../worker/render-worker.mjs");
  assert.match(worker, /campaign_id=not\.in\.\(\$\{keep\}\)&campaign_id=not\.like\.lemlist:\*/, "the campaign prune keeps lemlist rows");
  assert.match(worker, /day=gte\.\$\{startDay\}&sender_id=not\.like\.lemlist:\*/, "the daily window replace keeps lemlist senders");
  assert.match(worker, /const notLemlist = table === "rr_campaign_stats"/, "a full HeyReach pull keeps lemlist rows");
});

test("briefs, end of week and QC Bot read lemlist when a client has it", () => {
  for (const path of ["../app/api/slack/brief/route.ts", "../app/api/slack/eow-report/route.ts"]) {
    const route = source(path);
    assert.match(route, /gatherLiveFigures\(.*heyreach_api_key_ciphertext.*String\(\(found as Row\)\.lemlist_api_key/, `${path} passes the lemlist key`);
    assert.match(route, /or=\(heyreach_api_key_ciphertext\.not\.is\.null,lemlist_api_key\.not\.is\.null,emailbison_workspace_id\.not\.is\.null\)/, `${path} counts a lemlist or Email Bison account as connected`);
  }
  assert.match(source("../app/lib/personal-brief.ts"), /gatherLiveFigures\(str\(found\.heyreach_api_key_ciphertext\), str\(found\.lemlist_api_key\)\)/);
  const tools = source("../app/lib/assistant-tools.ts");
  for (const tool of ["heyreach_campaigns", "heyreach_campaign_metrics", "heyreach_senders", "heyreach_workspace_totals"]) {
    assert.match(tools, new RegExp(`case "${tool}": \\{[\\s\\S]{0,400}if \\(!lem\\.apiKey && lem\\.lemlistKey\\) return lemlist`), `${tool} answers from lemlist for a lemlist client`);
  }
});

import { classifyConversationOrigin } from "../shared/conversation-origin.mjs";

test("a lemlist thread that opens with the lead's reply is still our outreach (the invite carried no note)", () => {
  const verdict = classifyConversationOrigin({
    messages: [{ direction: "inbound", sent_at: "2026-10-01T10:00:00Z", raw_data: { reply_radar: { campaign: { id: "cam_1", name: "RCH004: Jose 1st Deg", source: "lemlist" } } } }],
    leadRawData: { reply_radar: { history_status: "complete" } },
  });
  assert.equal(verdict.origin, "outbound");
});
