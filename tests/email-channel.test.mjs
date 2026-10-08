// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emailConversationKey, htmlToText, isEmailConversationKey, replyText, stripQuoted } from "../shared/email-text.mjs";
import { classifyConversationOrigin } from "../shared/conversation-origin.mjs";

const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a reply keeps what the lead wrote and drops the quoted thread under it", () => {
  const body = "Thanks Amanda, yes let's talk next week.\n\nBest,\nRoo\n\nOn Tue, Oct 7, 2026 at 1:19 PM Amanda Ducach <amanda@emaappapp.com> wrote:\n> The EmaEQ team will be at WHIS\n> and we'd love to meet.";
  assert.equal(stripQuoted(body), "Thanks Amanda, yes let's talk next week.\n\nBest,\nRoo");
  assert.equal(stripQuoted("Sounds good\n\n-----Original Message-----\nFrom: x"), "Sounds good");
  assert.equal(stripQuoted("> only quoted"), "> only quoted", "nothing left means the whole text, not an empty card");
});

test("our campaign email (HTML) reads as text with its paragraphs", () => {
  const html = "<p>The EmaEQ team will be at WHIS, and we&#39;re excited to connect.</p><p>Worth a coffee?<br>Amanda</p>";
  assert.equal(htmlToText(html), "The EmaEQ team will be at WHIS, and we're excited to connect.\nWorth a coffee?\nAmanda");
  assert.equal(replyText({ text_body: "", html_body: "<div>Yes please</div>" }), "Yes please");
});

test("email threads have their own key that nothing mistakes for a HeyReach id", () => {
  assert.equal(emailConversationKey(4521), "bison:4521");
  assert.ok(isEmailConversationKey("bison:4521"));
  assert.ok(!isEmailConversationKey("2-ZDA1NjM"));
});

test("a tracked Email Bison reply counts as our outreach even if our email is missing from the thread", () => {
  const verdict = classifyConversationOrigin({
    messages: [{ direction: "inbound", sent_at: "2026-10-07T18:18:20Z", raw_data: { reply_radar: { campaign: { id: "62", name: "EM036: WHIS Email Non-Investors (Amanda)", source: "emailbison" } } } }],
    leadRawData: { reply_radar: { history_status: "complete" } },
  });
  assert.equal(verdict.origin, "outbound");
});

test("HeyReach code never touches email conversations", () => {
  const worker = source("../worker/render-worker.mjs");
  assert.match(worker, /heyreach_conversation_id=not\.like\.bison:\*/, "the hourly HeyReach refresh skips email threads");
  assert.match(worker, /!\/\^\(bison\|lemlist\):\/\.test\(String\(row\.heyreach_conversation_id \|\| ""\)\) && !inAccount\.has/, "the full HeyReach pull never deletes email or lemlist threads");
  assert.match(source("../app/lib/conversation-send.ts"), /startsWith\("bison:"\)[\s\S]{0,120}sendEmailConversationReply/, "sending an email reply goes through Email Bison");
  assert.match(source("../app/api/conversations/refresh/route.ts"), /startsWith\("bison:"\)\) return refreshEmailConversation/, "the inbox refresh reads email threads from Email Bison");
});

test("HeyReach code never touches lemlist conversations", () => {
  const worker = source("../worker/render-worker.mjs");
  assert.match(worker, /heyreach_conversation_id=not\.like\.lemlist:\*/, "the hourly HeyReach refresh skips lemlist threads");
  assert.match(source("../app/lib/conversation-send.ts"), /isLemlistConversationKey\(conversation\.heyreach_conversation_id\)\) \{[\s\S]{0,120}sendLemlistConversationReply/, "a lemlist reply is sent through lemlist");
  assert.match(source("../app/api/conversations/refresh/route.ts"), /isLemlistConversationKey\(conv\.heyreach_conversation_id\)\) return refreshLemlistConversation/, "the inbox refresh reads lemlist threads from lemlist");
  const ingest = source("../app/lib/lemlist-ingest.ts");
  assert.match(ingest, /if \(!isOurCampaign\(campaignName\)\) return \{ discarded: true, reason: "not_our_campaign"/, "lemlist replies follow the QC campaign code rule");
  assert.match(ingest, /isAutoReply\(/, "out-of-office emails from lemlist are dropped");
});

test("only tracked replies to coded campaigns are ingested", () => {
  const ingest = source("../app/lib/email-ingest.ts");
  assert.match(ingest, /text\(reply\.type\) !== "Tracked Reply"/);
  assert.match(ingest, /if \(!isOurCampaign\(campaign\)\) return \{ discarded: true, reason: "not_our_campaign" \}/);
});

test("out-of-office and automatic replies are recognised, real replies are not", async () => {
  const { isAutoReply, isOurEmail } = await import("../shared/email-text.mjs");
  assert.ok(isAutoReply({ text_body: "Hello, Thank you for your email. I am traveling until 9 October and will be slow to respond to emails. Warm regards, Rhiannon" }));
  assert.ok(isAutoReply({ text_body: "I will be out of the office until 10/13. For urgent issues contact…" }));
  assert.ok(isAutoReply({ subject: "Automatic reply: Meet EmaEQ at WHIS", text_body: "Thanks" }));
  assert.ok(isAutoReply({ automated_reply: true, text_body: "Hi!" }));
  assert.ok(!isAutoReply({ text_body: "Hi Nick, We can have a meeting about this. I am not sure what we have that we might be able to part of this program." }));
  assert.ok(!isAutoReply({ text_body: "Would love to attend, we have also integrated AI for testing and workflow and wearables." }));
  assert.ok(isOurEmail({ folder: "Sent", type: "Outgoing Email" }));
  assert.ok(!isOurEmail({ folder: "Inbox", type: "Tracked Reply" }));
});
