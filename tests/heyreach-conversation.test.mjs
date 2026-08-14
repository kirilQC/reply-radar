// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import assert from "node:assert/strict";
import test from "node:test";
import { isHeyReachValidationPayload, mergeConversationMessages, normalizeHeyReachMessages } from "../app/lib/heyreach-conversation.ts";

const sender = { id: "321", name: "Alex Sender" };
const fallback = "2026-08-08T18:14:09.000Z";

test("recognizes HeyReach's synthetic webhook validation lead without matching real events", () => {
  assert.equal(isHeyReachValidationPayload({ lead: { id: "TestId", full_name: "John Doe" }, sender: { id: 123 } }), true);
  assert.equal(isHeyReachValidationPayload({ lead: { id: "real-lead-id", full_name: "John Doe" }, sender: { id: 123 } }), false);
  assert.equal(isHeyReachValidationPayload({ lead: { profile_url: "https://linkedin.com/in/testid" } }), false);
});

test("normalizes webhook and API history messages with sender metadata", () => {
  const messages = normalizeHeyReachMessages([
    { id: "out-1", text: "First outreach", sender: "me", createdAt: "2026-08-08T18:00:00Z" },
    { messageId: "in-1", messageText: "Definitely", senderType: "LEAD", sentAt: "2026-08-08T18:14:09Z" },
  ], sender.id, sender, fallback, "history");

  assert.deepEqual(messages.map(({ externalId, direction, body }) => ({ externalId, direction, body })), [
    { externalId: "out-1", direction: "outbound", body: "First outreach" },
    { externalId: "in-1", direction: "inbound", body: "Definitely" },
  ]);
  assert.deepEqual(messages[0].raw.reply_radar, { source: "history", sender });
});

test("appends the webhook reply without duplicating a history message", () => {
  const history = normalizeHeyReachMessages([
    { id: "api-message", body: "Definitely", direction: "inbound", sentAt: "2026-08-08T18:14:09Z" },
  ], sender.id, sender, fallback, "history");
  const webhook = normalizeHeyReachMessages([
    { message: "Definitely", is_reply: true, creation_time: "2026-08-08T18:14:09Z" },
  ], sender.id, sender, fallback, "webhook");

  const merged = mergeConversationMessages(history, webhook);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].body, "Definitely");
  // The API history row stays canonical because it carries the real message id; the webhook copy is
  // kept beside it rather than replacing it, so nothing the webhook knew is lost to the merge.
  assert.equal(merged[0].raw.reply_radar.source, "history");
  assert.equal(merged[0].raw.webhook_message.reply_radar.source, "webhook");
});

test("keeps the complete thread in chronological order", () => {
  const history = normalizeHeyReachMessages([
    { body: "Second", isFromMe: false, sentAt: "2026-08-08T18:02:00Z" },
    { body: "First", isFromMe: true, sentAt: "2026-08-08T18:01:00Z" },
  ], sender.id, sender, fallback, "history");
  const merged = mergeConversationMessages(history, []);
  assert.deepEqual(merged.map((message) => message.body), ["First", "Second"]);
});
