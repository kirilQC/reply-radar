// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import assert from "node:assert/strict";
import test from "node:test";
import { isOurCampaign, ourCampaigns } from "../shared/campaign-code.mjs";

// Every name below was read off a live HeyReach account during the audit that produced this rule.
// They are the regression suite: the pattern was widened until each of these was classified correctly,
// and it must not be tightened again without checking them.
const ours = [
  "W040: Website ICP Visitors", // one letter — Willow
  "W001: Founders, UK",
  "CT052: Security leaders",
  "CT50: Older numbering", // two digits
  "CT049_R3_Connect_Logan", // underscore, no colon
  "CT:010 BSidesSD Speakers", // colon before the digits
  "Ct007: Mixed case",
  "  SW019: Core ICP Retarget  ", // leading and trailing whitespace off the API
  "SW021: Core ICP Retarget",
  "BV003: Ops leaders",
  "MS002: Founders",
];

const theirs = [
  "Webrix New Sequence",
  "Webrix October 25",
  "AWS re:invent 2025 New",
  "Gojiberry Leads",
  "Cotool Linkedin Followers",
  "Max-Test",
  "Willow AE Pool May 2026",
  "BH Pipeline Bucket",
  "BH CISO & Security Leaders",
  "Eyal Post Engagers - Jul 2026",
];

test("campaign codes we issued are recognised", () => {
  for (const name of ours) assert.equal(isOurCampaign(name), true, name);
});

test("campaigns a client launched before us are not", () => {
  for (const name of theirs) assert.equal(isOurCampaign(name), false, name);
});

test("a four-digit year is not a campaign number", () => {
  // The boundary that stops this is the whole reason the pattern is not `\d{2,}`.
  assert.equal(isOurCampaign("BH2026 Attendees"), false);
  assert.equal(isOurCampaign("Ws2025Q1"), false);
  assert.equal(isOurCampaign("BH026 Attendees"), true);
});

test("digits must follow the letters immediately", () => {
  // A space here would let "BH 2026 Attendees" through, and it is the client's own campaign.
  assert.equal(isOurCampaign("BH 026 Attendees"), false);
  assert.equal(isOurCampaign("Campaign 003"), false);
});

test("a code has to start the name, not appear inside it", () => {
  assert.equal(isOurCampaign("Retarget of CT003"), false);
});

test("unusable names are not ours rather than throwing", () => {
  for (const value of ["", "   ", null, undefined, 42, {}]) {
    assert.equal(isOurCampaign(value), false);
  }
});

test("ourCampaigns reads the name through the caller's accessor", () => {
  // The two HeyReach endpoints name the field differently; one rule has to serve both.
  const stats = [{ campaignName: "CT003: Ours" }, { campaignName: "Cotool Followers" }];
  const list = [{ name: "W001: Ours" }, { name: "Willow AE Pool" }];
  assert.deepEqual(ourCampaigns(stats, (row) => row.campaignName), [{ campaignName: "CT003: Ours" }]);
  assert.deepEqual(ourCampaigns(list, (row) => row.name), [{ name: "W001: Ours" }]);
  assert.deepEqual(ourCampaigns(null, (row) => row.name), []);
});
