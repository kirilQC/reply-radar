// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The daily connection series counts QC's campaigns only.
 *
 * CAMB's HeyReach key is CAMB's own account. Asked for the whole account, HeyReach returned their team's
 * own sending (110 requests a day) and the client portal showed it as QC's work on a client with no QC
 * campaign at all. These pin the three things that stop that coming back.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const worker = readFileSync(new URL("../worker/render-worker.mjs", import.meta.url), "utf8");
const daily = worker.slice(worker.indexOf("async function collectDailyStats"), worker.indexOf("async function staleAnalyticsWorkspace"));

test("the daily series is asked for QC's campaigns, never the whole account", () => {
  assert.match(daily, /ourCampaigns\(await heyReachCampaignPages\(apiKey\)/);
  assert.match(daily, /campaignIds: ourIds/);
  assert.doesNotMatch(daily, /JSON\.stringify\(\{ accountIds, campaignIds: \[\]/);
});

test("a client with no campaign of ours gets zeros, not the account's sending", () => {
  assert.match(daily, /ourIds\.length\s*\?/);
  assert.match(daily, /if \(!ourIds\.length\)/);
});

test("the stored window is replaced so stale rows cannot linger, unless a sender failed to load", () => {
  assert.match(daily, /method: "DELETE"/);
  assert.match(daily, /if \(!senderFailed\)/);
});
