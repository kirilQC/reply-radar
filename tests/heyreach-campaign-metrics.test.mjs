// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The funnel and the five figures the report prints.
 *
 * These are the numbers a client will check with a calculator, so the tests are about arithmetic that
 * has to survive contact with a real HeyReach payload: an acceptance rate that arrives as a fraction,
 * campaigns that sent nothing in the period, and the difference between a rate of zero and no rate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dailyStatsFor, emptyFunnel, reportMetrics, summariseDailyStats, summariseFunnel } from "../app/lib/heyreach-campaign-metrics.ts";

/** Shaped like a row from `/stats/GetOverallStatsByCampaign`, trimmed to what is read. */
const row = (over) => ({
  campaignId: "1",
  campaignName: "Campaign",
  connectionsSent: 0,
  connectionsAccepted: 0,
  connectionAcceptanceRate: 0,
  ...over,
});

test("HeyReach's 0-1 acceptance fraction is read as a percent", () => {
  const funnel = summariseFunnel([
    row({ campaignId: "7", campaignName: "Founders", connectionsSent: 236, connectionsAccepted: 60, connectionAcceptanceRate: 0.2542373 }),
  ]);
  assert.equal(funnel.available, true);
  assert.equal(funnel.rows[0].acceptanceRate.toFixed(2), "25.42");
  assert.equal(funnel.acceptanceRate.toFixed(2), "25.42");
});

test("a rate already expressed as a percent is left alone", () => {
  const funnel = summariseFunnel([row({ connectionsSent: 100, connectionsAccepted: 38, connectionAcceptanceRate: 38 })]);
  assert.equal(funnel.rows[0].acceptanceRate, 38);
});

test("a missing rate is derived from the two counts rather than reported as zero", () => {
  const funnel = summariseFunnel([row({ connectionsSent: 200, connectionsAccepted: 50, connectionAcceptanceRate: null })]);
  assert.equal(funnel.rows[0].acceptanceRate, 25);
});

test("the average is per campaign, so one large campaign cannot speak for the rest", () => {
  const funnel = summariseFunnel([
    row({ campaignId: "1", campaignName: "Big", connectionsSent: 3000, connectionsAccepted: 300, connectionAcceptanceRate: 0.1 }),
    row({ campaignId: "2", campaignName: "Small", connectionsSent: 100, connectionsAccepted: 50, connectionAcceptanceRate: 0.5 }),
  ]);
  // Pooled would be 350/3100 = 11.3%. The mean of the two campaigns is 30%.
  assert.equal(funnel.acceptanceRate, 30);
  assert.equal(funnel.connectionsSent, 3100);
  assert.equal(funnel.connectionsAccepted, 350);
  assert.equal(funnel.campaignCount, 2);
});

test("a campaign that sent nothing in the period is left out of the average, not counted as 0%", () => {
  const funnel = summariseFunnel([
    row({ campaignId: "1", campaignName: "Ran", connectionsSent: 100, connectionsAccepted: 40, connectionAcceptanceRate: 0.4 }),
    row({ campaignId: "2", campaignName: "Dormant", connectionsSent: 0, connectionsAccepted: 0, connectionAcceptanceRate: 0 }),
  ]);
  assert.equal(funnel.acceptanceRate, 40);
  // It is still counted as a campaign the report covers, because it is one of the campaigns named.
  assert.equal(funnel.campaignCount, 2);
});

test("campaigns are ordered by the connections that were actually accepted", () => {
  const funnel = summariseFunnel([
    row({ campaignId: "1", campaignName: "Few", connectionsSent: 10, connectionsAccepted: 2 }),
    row({ campaignId: "2", campaignName: "Many", connectionsSent: 400, connectionsAccepted: 120 }),
  ]);
  assert.deepEqual(
    funnel.rows.map((entry) => entry.name),
    ["Many", "Few"],
  );
});

test("junk in the payload cannot throw or invent a campaign", () => {
  const funnel = summariseFunnel([null, "nope", {}, 42, row({ campaignId: "9", campaignName: "Real" })]);
  assert.equal(funnel.rows.length, 1);
  assert.equal(funnel.rows[0].name, "Real");
  assert.equal(summariseFunnel("not an array").rows.length, 0);
});

test("a nameless row still reports under its id rather than blank", () => {
  const funnel = summariseFunnel([row({ campaignId: "412", campaignName: "" })]);
  assert.equal(funnel.rows[0].name, "Campaign 412");
});

test("both rates divide by accepted connections, which is who could be messaged", () => {
  const funnel = summariseFunnel([
    row({ campaignId: "1", campaignName: "A", connectionsSent: 500, connectionsAccepted: 200, connectionAcceptanceRate: 0.4 }),
  ]);
  const metrics = reportMetrics(funnel, { total: 30, positive: 12, leadsReplied: 28 });
  assert.equal(metrics.replyRate, 15);
  assert.equal(metrics.positiveReplyRate, 6);
  assert.equal(metrics.replies, 30);
  assert.equal(metrics.positiveReplies, 12);
  assert.equal(metrics.leadsReplied, 28);
  assert.equal(metrics.connectionsAccepted, 200);
});

test("no accepted connections means no rate rather than a division by zero", () => {
  const metrics = reportMetrics(summariseFunnel([row({ connectionsSent: 40 })]), {
    total: 0,
    positive: 0,
    leadsReplied: 0,
  });
  assert.equal(metrics.replyRate, 0);
  assert.equal(metrics.positiveReplyRate, 0);
  assert.ok(Number.isFinite(metrics.replyRate));
});

test("replies are carried per campaign, messages and InMails together", () => {
  // The morning brief prints these next to HeyReach's own screen, where the two kinds are one number.
  const funnel = summariseFunnel([row({ totalMessageReplies: 9, totalInmailReplies: 3 })]);
  assert.equal(funnel.rows[0].replies, 12);
  // A campaign with neither field reports none rather than NaN.
  assert.equal(summariseFunnel([row({})]).rows[0].replies, 0);
});

// ── The day-by-day series ────────────────────────────────────────────
//
// The brief's "nothing has been sent since Tuesday" line is read straight off this, and it is the line
// most likely to start a conversation with a client. So a gap has to stay a gap: a day HeyReach did not
// write a key for is a day nothing went out, and turning it into a zero row would make five quiet days
// indistinguishable from five days that were never collected.

test("byDayStats is read into a series, newest day first", () => {
  const days = summariseDailyStats({
    byDayStats: {
      "2026-08-14T00:00:00Z": { connectionsSent: 40, connectionsAccepted: 12, totalMessageReplies: 2, totalInmailReplies: 1 },
      "2026-08-17T00:00:00Z": { connectionsSent: 55, connectionsAccepted: 20, totalMessageReplies: 4, totalInmailReplies: 0 },
      "2026-08-16T00:00:00Z": { connectionsSent: 0, connectionsAccepted: 0 },
    },
  });
  assert.deepEqual(days.map((day) => day.day), ["2026-08-17", "2026-08-16", "2026-08-14"]);
  assert.deepEqual(days[0], { day: "2026-08-17", sent: 55, accepted: 20, replies: 4 });
  // 15 August has no key, and it must not appear — see the note above.
  assert.equal(days.length, 3);
  assert.equal(days[2].replies, 3);
});

test("a key that is not a date is dropped rather than becoming a day", () => {
  const days = summariseDailyStats({
    byDayStats: { total: { connectionsSent: 900 }, "": {}, "not-a-date": { connectionsSent: 5 }, "2026-08-17T00:00:00Z": { connectionsSent: 1 } },
  });
  assert.deepEqual(days.map((day) => day.day), ["2026-08-17"]);
});

test("a payload with no series at all is an empty series, not a throw", () => {
  assert.deepEqual(summariseDailyStats(null), []);
  assert.deepEqual(summariseDailyStats({ byDayStats: "nope" }), []);
  assert.deepEqual(summariseDailyStats({}), []);
});

test("the series is asked for only this client's campaigns, and never for the whole account", async () => {
  // HeyReach reads an empty `campaignIds` as "every campaign on the key". Several clients ran their own
  // outbound on the same key before the engagement, so an unscoped ask reports their sending as ours.
  const sent = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, json: async () => ({ byDayStats: { "2026-08-17T00:00:00Z": { connectionsSent: 3 } } }) };
  };
  try {
    const days = await dailyStatsFor("key", ["7", "9"], "2026-08-01T00:00:00.000Z", "2026-08-18T00:00:00.000Z");
    assert.deepEqual(days, [{ day: "2026-08-17", sent: 3, accepted: 0, replies: 0 }]);
    assert.match(sent[0].url, /\/stats\/GetOverallStats$/);
    assert.deepEqual(sent[0].body.campaignIds, [7, 9]);

    // No ids means the caller narrowed to nothing. Asking anyway would answer for the whole account, so
    // the call is not made at all and the caller is told it could not be read.
    assert.equal(await dailyStatsFor("key", [], "2026-08-01T00:00:00.000Z", "2026-08-18T00:00:00.000Z"), null);
    assert.equal(await dailyStatsFor("", ["7"], "2026-08-01T00:00:00.000Z", "2026-08-18T00:00:00.000Z"), null);
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("a series that could not be read is null, which is not the same as a quiet fortnight", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 502, json: async () => ({}) });
  try {
    assert.equal(await dailyStatsFor("key", ["7"], "2026-08-01T00:00:00.000Z", "2026-08-18T00:00:00.000Z"), null);
  } finally {
    globalThis.fetch = original;
  }
  globalThis.fetch = async () => {
    throw new Error("socket hang up");
  };
  try {
    assert.equal(await dailyStatsFor("key", ["7"], "2026-08-01T00:00:00.000Z", "2026-08-18T00:00:00.000Z"), null);
  } finally {
    globalThis.fetch = original;
  }
});

test("an unavailable funnel stays unavailable, with its reason, so no rate is printed as zero", () => {
  const metrics = reportMetrics(emptyFunnel("No HeyReach API key is saved for this client."), {
    total: 41,
    positive: 19,
    leadsReplied: 38,
  });
  assert.equal(metrics.available, false);
  assert.match(metrics.reason, /API key/);
  // The replies are ours and are known; only the rates that need HeyReach's denominator are missing.
  assert.equal(metrics.replies, 41);
  assert.equal(metrics.positiveReplies, 19);
  assert.equal(metrics.connectionsAccepted, 0);
  assert.equal(metrics.campaigns.length, 0);
});
