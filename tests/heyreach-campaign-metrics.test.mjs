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
import { emptyFunnel, reportMetrics, summariseFunnel } from "../app/lib/heyreach-campaign-metrics.ts";

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
