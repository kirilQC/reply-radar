// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Slack reply alerts. The card and the thread are what the team reads instead of the old n8n bot, so the
 * layout is pinned line by line; the claim is what keeps one reply to one card even when the webhook and
 * the worker's sweep reach it together; and the placeholder check is what stops "(insert time here)" from
 * reaching a lead.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const nextServerStub = `data:text/javascript,${encodeURIComponent("export const after = (fn) => fn(); export const NextResponse = { json: (body, init) => new Response(JSON.stringify(body), { status: init?.status ?? 200 }) };")}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return { url: nextServerStub, shortCircuit: true };
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";

const alert = await import("../app/lib/reply-alert.ts");
const { claimAlert } = await import("../app/lib/reply-alert-run.ts");

const DASHES = /[–—]/;

// A realistic rr_leads row: some columns set, some only in AI Ark, some missing everywhere.
const leadRow = {
  id: "lead-1",
  name: "Dana Whitfield",
  role: "VP of Operations",
  company: "Harbor & Pine Logistics",
  linkedin_profile_url: "https://www.linkedin.com/in/danawhitfield",
  raw_data: {
    reply_radar: {
      ai_ark: {
        headline: "Ops leader | Scaling 3PL networks",
        location: { default: "Austin, Texas, United States" },
        company: {
          summary: { name: "Harbor and Pine", industry: "Logistics & Supply Chain", staff: { total: 412, range: { start: 1001, end: 5000 } } },
          link: { website: "https://www.harborpine.com/about", linkedin: "https://www.linkedin.com/company/harborpine" },
          keywords: ["third party logistics", "#warehousing", "B2B SaaS", "freight", "Third Party Logistics"],
        },
      },
    },
  },
};

const at = (minute) => new Date(Date.UTC(2026, 9, 7, 14, minute)).toISOString();
const messages = [
  { id: "m1", direction: "outbound", body: "Hi Dana, saw Harbor & Pine is opening a new DC. Worth a chat?", sentAt: at(0), senderName: "Sam Ortiz" },
  { id: "m2", direction: "inbound", body: "Maybe. What does it cost?", sentAt: at(5) },
  { id: "m3", direction: "outbound", body: "Depends on volume. Can I send a short overview?", sentAt: at(9), senderName: "Sam Ortiz" },
  { id: "m4", direction: "inbound", body: "Sure, send it over.\nThursday works too.", sentAt: at(20) },
];

test("the card follows the n8n layout, with links in Slack's form and the count in the title", () => {
  const lead = alert.leadFromRow(leadRow);
  const card = alert.buildAlertCard({ lead, replyNumber: alert.replyNumber(messages, messages[3]), senderName: "Sam Ortiz", campaignName: "US Ops Q4", clientName: "Willow" });
  const body = card.blocks.map((block) => block.text?.text ?? "").join("\n\n");
  assert.equal(card.blocks[0].text.text, ":arrows_counterclockwise: *New Reply · Reply #2*");
  assert.match(body, /\*Name:\* Dana Whitfield\n\*Title:\* VP of Operations\n\*Headline:\* Ops leader \| Scaling 3PL networks\n\*LinkedIn:\* <https:\/\/www\.linkedin\.com\/in\/danawhitfield\|View Profile>\n\*Location:\* Austin, Texas, United States/);
  // The rr_leads company wins over AI Ark's, and & is escaped for mrkdwn.
  assert.match(body, /\*Company:\* Harbor &amp; Pine Logistics/);
  // staff.total (412) is never used; the LinkedIn size band is.
  assert.match(body, /\*Industry:\* Logistics &amp; Supply Chain \| 1,001-5,000 employees/);
  assert.match(body, /\*Pattern Tags:\* Third Party Logistics, Warehousing, B2B SaaS\n/);
  assert.match(body, /\*Domain:\* <https:\/\/harborpine\.com\|harborpine\.com>/);
  assert.match(body, /\*Company LinkedIn:\* <https:\/\/www\.linkedin\.com\/company\/harborpine\|View Profile>/);
  assert.match(body, /\*Sender:\* Sam Ortiz\n\*Campaign:\* US Ops Q4/);
  assert.equal(card.text, "New reply from Dana Whitfield (Willow)");
  assert.doesNotMatch(JSON.stringify(card), DASHES);
});

test("unknown fields are left out of the card rather than printed blank", () => {
  const lead = alert.leadFromRow({ name: "Lee Park", company: "Quiet Co", raw_data: {} });
  const card = alert.buildAlertCard({ lead, replyNumber: 1, senderName: "", campaignName: "", clientName: "" });
  const body = card.blocks.map((block) => block.text?.text ?? "").join("\n");
  // A first reply gets :email:, a later one :arrows_counterclockwise:, as the n8n bot did.
  assert.equal(card.blocks[0].text.text, ":email: *New Reply · Reply #1*");
  assert.match(alert.buildAlertCard({ lead, replyNumber: 3, senderName: "", campaignName: "", clientName: "" }).blocks[0].text.text, /^:arrows_counterclockwise: \*New Reply · Reply #3\*$/);
  for (const label of ["Title", "Headline", "LinkedIn", "Email", "Location", "Industry", "Pattern Tags", "Domain", "Company LinkedIn", "Sender", "Campaign", "Company Summary"]) {
    assert.doesNotMatch(body, new RegExp(`\\*${label}:\\*`), label);
  }
  assert.match(body, /\*Name:\* Lee Park/);
  assert.match(body, /\*Company:\* Quiet Co/);
  assert.equal(card.blocks.length, 3, "the empty sender group adds no block");
  assert.equal(card.text, "New reply from Lee Park");
});

test("headcount: the enriched figure first, then the size band, and an open band reads 10,001+", () => {
  assert.equal(alert.headcountText(250, { range: { start: 51, end: 200 } }), "250");
  assert.equal(alert.headcountText(null, { total: 9, range: { start: 10001 } }), "10,001+");
  assert.equal(alert.headcountText(null, { total: 12 }), "");
  const lead = alert.leadFromRow({ name: "A", company_industry: "Retail", raw_data: {} });
  assert.match(alert.buildAlertCard({ lead, replyNumber: 1, senderName: "", campaignName: "", clientName: "" }).blocks[2].text.text, /^\*Industry:\* Retail$/m);
});

test("Reply #N counts the lead's messages up to this one", () => {
  assert.equal(alert.replyNumber(messages, messages[1]), 1);
  assert.equal(alert.replyNumber(messages, messages[3]), 2);
});

test("the thread is the conversation by speaker, then an editable draft and a confirmed Send", () => {
  const thread = alert.buildAlertThread({ messages, latest: messages[3], messageId: "m4", leadName: "Dana Whitfield", senderName: "Sam Ortiz", draft: "Great, sending it now. Does (insert time here) work?", conversationId: "conv-1" });
  const types = thread.blocks.map((block) => block.type);
  assert.deepEqual(types, ["section", "rich_text", "divider", "input", "actions"]);
  assert.equal(thread.blocks[0].text.text, "*Conversation History*");
  const history = thread.blocks[1].elements[0].elements[0].text;
  assert.equal(history.split("\n\n")[0], "1. Sam Ortiz: Hi Dana, saw Harbor & Pine is opening a new DC. Worth a chat?");
  assert.match(history, /\n\n2\. Dana Whitfield: Maybe\. What does it cost\?\n\n3\. Sam Ortiz: /);
  // The latest lead reply is on the card now, not in the thread.
  assert.doesNotMatch(JSON.stringify(thread), /Latest Lead Reply/);
  assert.equal(thread.blocks[2].block_id, alert.REPLY_HEADING_BLOCK_ID);
  const input = thread.blocks[3];
  assert.equal(input.block_id, alert.DRAFT_BLOCK_ID);
  assert.equal(input.label.text, "Generated Reply");
  assert.equal(input.dispatch_action, false);
  assert.equal(input.element.multiline, true);
  assert.equal(input.element.initial_value, "Great, sending it now. Does (insert time here) work?");
  const button = thread.blocks[4].elements[0];
  assert.equal(button.action_id, alert.SEND_REPLY_ACTION);
  assert.equal(button.style, "primary");
  assert.equal(button.confirm.text.text, "Send this reply to Dana Whitfield on LinkedIn from Sam Ortiz?");
  assert.deepEqual(alert.parseSendValue(button.value), { messageId: "m4", conversationId: "conv-1", test: false });
  assert.doesNotMatch(JSON.stringify(thread), DASHES);
});

test("the card carries the latest lead reply, preformatted, and no company summary", () => {
  const lead = alert.leadFromRow({ name: "Dana Whitfield", company: "Harbor & Pine", raw_data: { reply_radar: { ai_ark: { company: { summary: { description: "A long company description." } } } } } });
  const card = alert.buildAlertCard({ lead, replyNumber: 2, senderName: "Sam Ortiz", campaignName: "HP001: DCs", clientName: "Harbor", latestReply: "Sure, send it over.\nThursday works too." });
  const heading = card.blocks.findIndex((block) => block.text?.text === "*Latest Lead Reply*");
  assert.ok(heading > 0);
  assert.equal(card.blocks[heading + 1].elements[0].elements[0].text, "Sure, send it over.\nThursday works too.");
  assert.doesNotMatch(JSON.stringify(card), /Company Summary|A long company description/);
});

test("a very long conversation keeps the newest messages, numbered as they really are, inside Slack's block limit", () => {
  const long = Array.from({ length: 400 }, (_, index) => ({ id: `x${index}`, direction: index % 2 ? "inbound" : "outbound", body: `message ${index} ${"word ".repeat(60)}`, sentAt: at(index) }));
  const thread = alert.buildAlertThread({ messages: long, latest: long[399], messageId: "x399", leadName: "Dana", senderName: "Sam", draft: "", conversationId: "c" });
  assert.ok(thread.blocks.length <= 50, `${thread.blocks.length} blocks`);
  const history = thread.blocks.filter((block) => block.type === "rich_text").map((block) => block.elements[0].elements[0].text).join("\n\n");
  assert.match(history, /^\(\d+ earlier messages not shown\)/);
  assert.match(history, /400\. Dana: message 399/);
  assert.equal(thread.blocks.find((block) => block.type === "input").element.initial_value, undefined, "no draft means an empty box, not a blank string");
});

test("a test card says so and its button is marked as a test", () => {
  const card = alert.buildAlertCard({ lead: alert.leadFromRow({ name: "Dana" }), replyNumber: 1, senderName: "", campaignName: "", clientName: "Willow", test: true });
  assert.equal(card.text, "Test: New reply from Dana (Willow)");
  const thread = alert.buildAlertThread({ messages, latest: messages[3], messageId: "m4", leadName: "Dana", senderName: "Sam", draft: "x", conversationId: "c", test: true });
  assert.equal(alert.parseSendValue(thread.blocks.at(-1).elements[0].value).test, true);
});

test("a draft still holding a blank is refused, and the edited text is read from Slack's state", () => {
  const state = { values: { [alert.DRAFT_BLOCK_ID]: { [alert.DRAFT_ACTION_ID]: { type: "plain_text_input", value: "  Thursday at (insert time here)?  " } } } };
  const draft = alert.draftFromState(state);
  assert.equal(draft, "Thursday at (insert time here)?");
  const refused = alert.sendableCheck(draft);
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /\(insert time here\)/);
  assert.equal(alert.sendableCheck("Here's the [link]").ok, false);
  assert.equal(alert.sendableCheck("   ").ok, false);
  assert.deepEqual(alert.sendableCheck("Thursday at 2pm works."), { ok: true });
  assert.equal(alert.draftFromState({}), "");
});

test("once sent, the box and button give way to who sent it and the exact text", () => {
  const thread = alert.buildAlertThread({ messages, latest: messages[3], messageId: "m4", leadName: "Dana", senderName: "Sam", draft: "x", conversationId: "c" });
  const sent = alert.sentThreadBlocks(thread.blocks, { userId: "U123", message: "Thursday 2pm works.\nSee you then & thanks", at: new Date(Date.UTC(2026, 9, 7, 19, 42)) });
  assert.ok(!sent.some((block) => block.type === "input" || block.type === "actions"));
  assert.ok(!sent.some((block) => block.block_id === alert.REPLY_HEADING_BLOCK_ID));
  assert.equal(sent.at(-2).text.text, "*Sent by* <@U123> · Oct 7, 3:42 PM ET");
  assert.equal(sent.at(-1).text.text, "> Thursday 2pm works.\n> See you then &amp; thanks");
  assert.equal(sent[0].text.text, "*Conversation History*", "the conversation stays");
});

test("copies of one reply share a claim key: the oldest copy's id", () => {
  const rows = [
    { id: "b", body: "Sure, send it over.", sentAt: at(20) },
    { id: "a", body: "Sure, send it over. ", sentAt: at(22) },
    { id: "c", body: "Sure, send it over.", sentAt: at(50) },
    { id: "d", body: "Different", sentAt: at(20) },
  ];
  const window = 5 * 60_000;
  assert.deepEqual(alert.twinIds(rows, rows[0], window), ["b", "a"]);
  assert.deepEqual(alert.twinIds(rows, rows[1], window), ["b", "a"]);
  assert.deepEqual(alert.twinIds(rows, rows[2], window), ["c"]);
});

test("claim verdicts: posted stays posted, a live claim is busy, failures retry after a pause and stop at three", () => {
  const now = Date.parse(at(30));
  const minutesAgo = (n) => new Date(now - n * 60_000).toISOString();
  assert.equal(alert.claimVerdict(null, now), "take");
  assert.equal(alert.claimVerdict({ status: "posted", token: "t", attempts: 0, claimed_at: minutesAgo(1) }, now), "posted");
  assert.equal(alert.claimVerdict({ status: "claimed", token: "t", attempts: 0, claimed_at: minutesAgo(1) }, now), "busy");
  assert.equal(alert.claimVerdict({ status: "claimed", token: "t", attempts: 0, claimed_at: minutesAgo(10) }, now), "take", "a dead run's claim is taken over");
  assert.equal(alert.claimVerdict({ status: "claimed", token: "t", attempts: 2, claimed_at: minutesAgo(10) }, now), "gave_up", "a third death is the last");
  assert.equal(alert.claimVerdict({ status: "failed", token: "t", attempts: 1, claimed_at: minutesAgo(2), failed_at: minutesAgo(1) }, now), "busy");
  assert.equal(alert.claimVerdict({ status: "failed", token: "t", attempts: 1, claimed_at: minutesAgo(9), failed_at: minutesAgo(8) }, now), "take");
  assert.equal(alert.claimVerdict({ status: "failed", token: "t", attempts: 3, claimed_at: minutesAgo(30), failed_at: minutesAgo(30) }, now), "gave_up");
  assert.equal(alert.sendClaimVerdict(null, now), "take");
  assert.equal(alert.sendClaimVerdict({ status: "sent", token: "t", at: minutesAgo(60) }, now), "sent");
  assert.equal(alert.sendClaimVerdict({ status: "sending", token: "t", at: minutesAgo(1) }, now), "busy");
  assert.equal(alert.sendClaimVerdict({ status: "sending", token: "t", at: minutesAgo(30) }, now), "take");
});

/**
 * rr_app_config as PostgREST would answer: insert refused with 409 on a taken key, and a PATCH filtered on
 * `value->>token` changing only a row that still holds that token.
 */
function fakeAppConfig() {
  const table = new Map();
  const fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const key = decodeURIComponent((url.searchParams.get("key") ?? "").replace(/^eq\./, ""));
    if (method === "POST") {
      const row = JSON.parse(init.body);
      if (table.has(row.key)) return new Response(JSON.stringify({ code: "23505" }), { status: 409 });
      table.set(row.key, structuredClone(row.value));
      return new Response("", { status: 201 });
    }
    if (method === "GET") return new Response(JSON.stringify(table.has(key) ? [{ value: table.get(key) }] : []), { status: 200 });
    if (method === "PATCH") {
      const token = (url.searchParams.get("value->>token") ?? "").replace(/^eq\./, "");
      const current = table.get(key);
      if (!current || current.token !== token) return new Response("[]", { status: 200 });
      table.set(key, structuredClone(JSON.parse(init.body).value));
      return new Response(JSON.stringify([{ key }]), { status: 200 });
    }
    return new Response("", { status: 405 });
  };
  return { table, fetch };
}

test("claimAlert: two runs reaching one reply together, only one posts", async () => {
  const fake = fakeAppConfig();
  const original = globalThis.fetch;
  globalThis.fetch = fake.fetch;
  try {
    const config = { url: "https://fake.supabase.test", key: "k" };
    const now = Date.parse(at(30));
    const [first, second] = await Promise.all([claimAlert(config, "reply_alert:m4", now), claimAlert(config, "reply_alert:m4", now)]);
    assert.deepEqual([first.verdict, second.verdict].sort(), ["busy", "take"]);

    // The winner fails; inside the retry pause nobody may take it, after it exactly one run does.
    const winner = first.verdict === "take" ? first : second;
    fake.table.set("reply_alert:m4", { status: "failed", token: winner.token, attempts: 1, claimed_at: new Date(now).toISOString(), failed_at: new Date(now).toISOString(), error: "channel_not_found" });
    assert.equal((await claimAlert(config, "reply_alert:m4", now + 60_000)).verdict, "busy");
    const later = now + 6 * 60_000;
    const retries = await Promise.all([claimAlert(config, "reply_alert:m4", later), claimAlert(config, "reply_alert:m4", later)]);
    assert.deepEqual(retries.map((r) => r.verdict).sort(), ["busy", "take"]);
    assert.equal(retries.find((r) => r.verdict === "take").attempts, 1);

    // Posted is final.
    fake.table.set("reply_alert:m4", { status: "posted", token: "x", attempts: 1, claimed_at: new Date(now).toISOString(), channel: "C1", ts: "1.2", posted_at: new Date(now).toISOString() });
    const done = await claimAlert(config, "reply_alert:m4", later + 3_600_000);
    assert.equal(done.verdict, "posted");
    assert.equal(done.existing.ts, "1.2");
  } finally {
    globalThis.fetch = original;
  }
});

test("claimAlert fails closed when the claim table cannot be reached", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("down", { status: 503 });
  try {
    const result = await claimAlert({ url: "https://fake.supabase.test", key: "k" }, "reply_alert:m9");
    assert.equal(result.verdict, "error");
  } finally {
    globalThis.fetch = original;
  }
});
