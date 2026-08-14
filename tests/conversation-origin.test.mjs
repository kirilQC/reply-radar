// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The rule that keeps cold DMs out of the inbox, which had to be fixed five times before it held.
 *
 * Every previous version failed the same way, and it was never the message comparison that broke.
 * It was that a campaign name counted as proof we had approached someone, while ingestion was
 * inventing campaign names from the sending account's roster — so a stranger who messaged us out of
 * nowhere arrived carrying a genuine-looking campaign and short-circuited the comparison before it
 * ever ran. These tests pin the fix from both ends: an unvouched campaign name must not rescue an
 * inbound-first thread, and a vouched one still must, because a campaign can open with a connection
 * request rather than a message.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { classifyConversationOrigin, isLeadInitiated } from "../shared/conversation-origin.mjs";

const complete = { reply_radar: { history_status: "complete" } };

/** @param {string} direction @param {string} sentAt @param {object} [campaign] */
const message = (direction, sentAt, campaign) => ({
  direction,
  sent_at: sentAt,
  raw_data: campaign ? { reply_radar: { campaign } } : {},
});

test("a cold DM carrying a scraped campaign name is still the lead approaching us", () => {
  // The regression, exactly as it appeared: a lead in none of our campaigns, holding a campaign name
  // that came from a payload scan rather than from HeyReach. That name is a label, not evidence.
  const verdict = classifyConversationOrigin({
    messages: [
      message("inbound", "2026-08-01T09:00:00.000Z", { id: "88", name: "W040: Website ICP Visitors", source: "derived" }),
      message("outbound", "2026-08-01T11:00:00.000Z", { id: "88", name: "W040: Website ICP Visitors", source: "derived" }),
    ],
    leadRawData: complete,
  });
  assert.equal(verdict.origin, "inbound_lead");
});

test("a campaign name with no recorded source proves nothing", () => {
  // Rows written before `source` existed. Those are the ones already sitting in the database, and
  // re-judging them on the thread is the point — otherwise the purge can never reach them.
  assert.equal(
    isLeadInitiated({
      messages: [
        message("inbound", "2026-07-02T08:00:00.000Z", { id: "12", name: "BV006: ASC Management Firms" }),
        message("outbound", "2026-07-02T15:00:00.000Z", { id: "12", name: "BV006: ASC Management Firms" }),
      ],
      leadRawData: complete,
    }),
    true,
  );
});

test("confirmed enrollment outranks an inbound first message", () => {
  // The case the campaign exemption exists for: the campaign's first touch was a connection request,
  // so the first *message* is theirs, but we are the ones who went and found them. Both trusted
  // sources have to work, because attribution arrives by either route.
  for (const source of ["membership", "webhook"]) {
    const verdict = classifyConversationOrigin({
      messages: [
        message("inbound", "2026-08-01T09:00:00.000Z", { id: "5", name: "W012: Ops Leaders", source }),
        message("outbound", "2026-08-01T10:00:00.000Z", { id: "5", name: "W012: Ops Leaders", source }),
      ],
      leadRawData: complete,
    });
    assert.equal(verdict.origin, "outbound", `${source} attribution should count as outreach`);
  }
});

test("a trusted source with no campaign to name is not attribution", () => {
  assert.equal(
    isLeadInitiated({
      messages: [message("inbound", "2026-08-01T09:00:00.000Z", { id: "", name: "", source: "membership" })],
      leadRawData: complete,
    }),
    true,
  );
});

test("sending the first message is what makes a thread ours", () => {
  const verdict = classifyConversationOrigin({
    messages: [message("outbound", "2026-08-01T09:00:00.000Z"), message("inbound", "2026-08-01T12:00:00.000Z")],
    leadRawData: complete,
  });
  assert.equal(verdict.origin, "outbound");
});

test("message order is read as time, not as text", () => {
  // Out of order on the way in, and the earliest message is the outbound one.
  const verdict = classifyConversationOrigin({
    messages: [message("inbound", "2026-08-02T09:00:00.000Z"), message("outbound", "2026-07-30T09:00:00.000Z")],
    leadRawData: complete,
  });
  assert.equal(verdict.origin, "outbound");
});

test("a thread we could not read in full is never called inbound", () => {
  // HeyReach was unreachable, so we hold the newest messages only and the earliest one we have is
  // not the earliest one that exists. Discarding on that would delete live deals.
  for (const leadRawData of [{ reply_radar: { history_status: "webhook_fallback" } }, {}, null]) {
    const verdict = classifyConversationOrigin({ messages: [message("inbound", "2026-08-01T09:00:00.000Z")], leadRawData });
    assert.equal(verdict.origin, "unknown");
    assert.match(verdict.reason, /unknown/i);
  }
});

test("an unusable timestamp abstains rather than guessing the order", () => {
  const verdict = classifyConversationOrigin({
    messages: [message("inbound", "not a date"), message("outbound", "2026-08-01T09:00:00.000Z")],
    leadRawData: complete,
  });
  assert.equal(verdict.origin, "unknown");
});

test("a conversation with nothing stored yet is unknown, not inbound", () => {
  assert.equal(classifyConversationOrigin({ messages: [], leadRawData: complete }).origin, "unknown");
  assert.equal(classifyConversationOrigin({ messages: undefined, leadRawData: complete }).origin, "unknown");
});
