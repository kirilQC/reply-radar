// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { keepStoredState, supersededManualRows } from "../shared/ingest-merge.mjs";

test("re-reading a thread keeps the stored sentiment, draft and Slack alert while the platform's fields win", () => {
  const stored = [{ heyreach_message_id: "lemlist:act_1", raw_data: { channel: "email", reply_radar: { sentiment: "positive", cached_draft: "Hi!", reply_alert: { ts: "1.2" }, campaign: { name: "OLD" } } } }];
  const fresh = [{ heyreach_message_id: "lemlist:act_1", direction: "inbound", raw_data: { channel: "email", reply_radar: { campaign: { name: "RCH004" }, automated: false } } }];
  const [merged] = keepStoredState(fresh, stored);
  assert.equal(merged.raw_data.reply_radar.sentiment, "positive");
  assert.equal(merged.raw_data.reply_radar.cached_draft, "Hi!");
  assert.deepEqual(merged.raw_data.reply_radar.reply_alert, { ts: "1.2" });
  assert.equal(merged.raw_data.reply_radar.campaign.name, "RCH004");
});

test("a new message comes through untouched", () => {
  const fresh = [{ heyreach_message_id: "bison:reply:9", raw_data: { reply_radar: { channel: "email" } } }];
  assert.deepEqual(keepStoredState(fresh, []), fresh);
});

test("our own copy of a sent reply gives way once the platform's copy arrives, and only then", () => {
  const stored = [
    { id: "m1", heyreach_message_id: "lemlist:manual:1", direction: "outbound", sent_at: "2026-10-08T10:00:00Z" },
    { id: "m2", heyreach_message_id: "lemlist:manual:2", direction: "outbound", sent_at: "2026-10-08T15:00:00Z" },
  ];
  const fresh = [{ heyreach_message_id: "lemlist:act_9", direction: "outbound", sent_at: "2026-10-08T10:00:20Z" }];
  assert.deepEqual(supersededManualRows(stored, fresh, "lemlist:"), ["m1"]);
});
