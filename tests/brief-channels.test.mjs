// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { channelFiguresAsText, gatherChannelFigures } from "../shared/brief-channels.mjs";

const NOW = Date.parse("2026-10-08T12:00:00Z");
const fakeRead = async (path) => {
  if (path.startsWith("rr_email_campaign_stats")) return [{ name: "NK010: Email CFOs", status: "active", leads_contacted: 200, emails_sent: 420, unique_replies: 9, interested: 3, bounced: 4 }, { name: "Their own blast", emails_sent: 999 }];
  if (path.startsWith("rr_email_daily_stats")) return [{ day: "2026-10-07", sent: 60, replies: 2, interested: 1 }, { day: "2026-09-28", sent: 40, replies: 1, interested: 0 }];
  if (path.startsWith("rr_conversations")) return [{ id: "c1", channel: "linkedin", heyreach_conversation_id: "123" }, { id: "c2", channel: "email", heyreach_conversation_id: "bison:9" }, { id: "c3", channel: "email", heyreach_conversation_id: "lemlist:ctc_1:email" }];
  if (path.startsWith("rr_messages")) return [
    { conversation_id: "c1", sent_at: "2026-10-07T10:00:00Z", sentiment: "positive" },
    { conversation_id: "c2", sent_at: "2026-10-06T10:00:00Z", sentiment: "neutral" },
    { conversation_id: "c3", sent_at: "2026-09-29T10:00:00Z", sentiment: "positive" },
  ];
  if (path.startsWith("rr_meetings")) return [{ created_at: "2026-10-05T10:00:00Z" }, { created_at: "2026-09-27T10:00:00Z" }, { created_at: "2026-09-26T10:00:00Z" }];
  return [];
};

test("briefs count replies per channel, positives, meetings and our email campaigns only", async () => {
  const figures = await gatherChannelFigures(fakeRead, "ws", NOW);
  assert.deepEqual(figures.replies.recent, { linkedin: 1, email: 1, positive: 1 });
  assert.deepEqual(figures.replies.prior, { linkedin: 0, email: 1, positive: 1 });
  assert.deepEqual(figures.meetings, { recent: 1, prior: 2 });
  assert.equal(figures.email.campaigns.length, 1, "the client's own uncoded email campaign is left out");
  assert.deepEqual(figures.email.recent, { sent: 60, replies: 2, interested: 1 });
  const text = channelFiguresAsText(figures);
  assert.match(text, /1 on LinkedIn, 1 by email/);
  assert.match(text, /NK010: Email CFOs \[active\]: 200 leads contacted, 420 emails sent, 9 replied \(4\.5% of leads contacted replied\)/);
});

test("a brief with nothing to read on these tables says nothing broken", async () => {
  const figures = await gatherChannelFigures(async () => { throw new Error("down"); }, "ws", NOW);
  assert.equal(figures.email, null);
  assert.equal(figures.meetings.recent, 0);
});
