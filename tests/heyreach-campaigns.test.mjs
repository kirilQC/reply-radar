// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Live campaign status, and the definition of "active" that the whole feature turns on.
 *
 * HeyReach keeps a campaign in IN_PROGRESS while leads already in the sequence finish their steps, so
 * its own status cannot answer "what is working for this client?". Ours can: active means live *and*
 * still holding pending leads. Getting that backwards tells a client four campaigns are running when
 * two are, which is the failure these tests exist to catch.
 *
 * There is no HeyReach account in CI, so the fetch is untestable here — what gets tested is the
 * sorting of a real `/campaign/GetAll` payload, against a fixture copied from an actual response.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  allCampaigns,
  classifyReportedState,
  emptyStatus,
  resolveState,
  selectCampaigns,
  sendingDaysLeft,
  stateByName,
  summariseCampaigns,
} from "../app/lib/heyreach-campaigns.ts";
import { DEFAULT_TEMPLATE_PAGES, PAGE_LIMIT } from "../app/lib/report-templates.ts";
import { PAGE_CAPACITY, paginate } from "../shared/report-pagination.mjs";

/** Trimmed from a real response — field names and casing are exactly as HeyReach returns them. */
const LIVE_CAMPAIGN = {
  id: 544987,
  name: "W040: Website ICP Visitors",
  creationTime: "2026-08-10T19:15:42.328839Z",
  status: "IN_PROGRESS",
  progressStats: {
    totalUsers: 711,
    totalUsersInProgress: 85,
    totalUsersPending: 298,
    totalUsersFinished: 159,
  },
  startedAt: "2026-08-10T19:17:05.558054Z",
};

/** The same campaign a fortnight later: nobody new left to contact, so it is finished to us. */
const WORKED_THROUGH_CAMPAIGN = {
  id: 544001,
  name: "W039: Ops leaders, US",
  status: "IN_PROGRESS",
  progressStats: {
    totalUsers: 420,
    totalUsersInProgress: 96,
    totalUsersPending: 0,
    totalUsersFinished: 324,
  },
  startedAt: "2026-07-02T09:00:00.000Z",
};

test("every status HeyReach documents is recognised", () => {
  // These eight are the values the campaign list endpoint accepts as filters, so they are the full
  // vocabulary. An unrecognised one would land a live campaign in the wrong bucket.
  const expected = {
    DRAFT: "draft",
    IN_PROGRESS: "running",
    STARTING: "running",
    SCHEDULED: "scheduled",
    PAUSED: "paused",
    FINISHED: "closed",
    CANCELED: "closed",
    FAILED: "closed",
  };
  for (const [status, state] of Object.entries(expected)) {
    assert.equal(classifyReportedState(status), state, `${status} should classify as ${state}`);
  }
});

test("status matching survives the casing and punctuation the API might use", () => {
  for (const status of ["in_progress", "In Progress", "IN-PROGRESS", " IN_PROGRESS "]) {
    assert.equal(classifyReportedState(status), "running", `${JSON.stringify(status)} should be running`);
  }
  assert.equal(classifyReportedState(""), "unknown");
  assert.equal(classifyReportedState(null), "unknown");
});

test("active means running with pending leads, and nothing else does", () => {
  assert.equal(resolveState("running", 298), "active");
  // The rule in one line: in progress with nobody left to contact is complete, however many leads are
  // still walking through the sequence.
  assert.equal(resolveState("running", 0), "worked-through");
  // Pending leads do not make a paused or scheduled campaign active — it is not contacting anyone.
  assert.equal(resolveState("paused", 500), "paused");
  assert.equal(resolveState("scheduled", 500), "scheduled");
  assert.equal(resolveState("closed", 500), "closed");
  // An unreadable status with work left is treated as live: over-reporting a campaign that is on the
  // list beats hiding one that is working.
  assert.equal(resolveState("unknown", 12), "active");
  assert.equal(resolveState("unknown", 0), "unknown");
});

test("a real campaign row is sorted into active with its progress intact", () => {
  const status = summariseCampaigns([LIVE_CAMPAIGN]);
  assert.equal(status.available, true);
  assert.equal(status.total, 1);
  assert.equal(status.active.length, 1);
  const [row] = status.active;
  assert.equal(row.id, "544987");
  assert.equal(row.name, "W040: Website ICP Visitors");
  assert.equal(row.status, "IN_PROGRESS");
  assert.equal(row.state, "active");
  assert.equal(row.launchedAt, "2026-08-10T19:17:05.558Z");
  // Contacted is deliberately one number: in-sequence and completed both mean "already approached".
  assert.deepEqual(row.progress, { listSize: 711, pending: 298, contacted: 244 });
});

test("a campaign HeyReach still calls in progress is complete once the list is exhausted", () => {
  const status = summariseCampaigns([LIVE_CAMPAIGN, WORKED_THROUGH_CAMPAIGN]);
  assert.deepEqual(status.active.map((row) => row.name), ["W040: Website ICP Visitors"]);
  assert.deepEqual(status.workedThrough.map((row) => row.name), ["W039: Ops leaders, US"]);
  // Both are IN_PROGRESS in HeyReach. Reporting two as active is the mistake.
  assert.equal(status.workedThrough[0].status, "IN_PROGRESS");
  assert.equal(status.workedThrough[0].progress.contacted, 420);
});

test("each state lands in its own list and drafts stay out of all of them", () => {
  const pending = { progressStats: { totalUsers: 10, totalUsersPending: 10 } };
  const status = summariseCampaigns([
    { id: 1, name: "CT001: Live", status: "IN_PROGRESS", ...pending },
    { id: 2, name: "CT002: Next week", status: "SCHEDULED", ...pending },
    { id: 3, name: "CT003: Held", status: "PAUSED", ...pending },
    { id: 4, name: "CT004: Done", status: "FINISHED" },
    { id: 5, name: "CT005: Never launched", status: "DRAFT", ...pending },
  ]);
  assert.deepEqual(status.active.map((row) => row.name), ["CT001: Live"]);
  assert.deepEqual(status.scheduled.map((row) => row.name), ["CT002: Next week"]);
  assert.deepEqual(status.paused.map((row) => row.name), ["CT003: Held"]);
  // Closed and draft campaigns are counted but never listed: a client hears about neither, and a draft
  // with a full list must not be dressed up as active.
  assert.deepEqual(allCampaigns(status).map((row) => row.name), ["CT001: Live", "CT002: Next week", "CT003: Held"]);
  assert.equal(status.total, 5);
});

test("the closed and draft campaigns are still reachable, because a second call needs their ids", () => {
  /*
   * The four lists above answer "what is live?" and are right to leave the archive out. Two other
   * questions need it. A day-by-day series narrowed to the live lists drops the sends made by a campaign
   * that finished on Tuesday, so this week's total comes out below the client's own dashboard. And a
   * campaign count that omits the finished ones cannot be checked against HeyReach's own screen, which is
   * the only check anybody ever performs on it.
   */
  const pending = { progressStats: { totalUsers: 10, totalUsersPending: 10 } };
  const status = summariseCampaigns([
    { id: 1, name: "CT001: Live", status: "IN_PROGRESS", ...pending },
    { id: 4, name: "CT004: Done", status: "FINISHED" },
    { id: 5, name: "CT005: Never launched", status: "DRAFT", ...pending },
  ]);
  assert.deepEqual(status.all.map((row) => row.name).sort(), ["CT001: Live", "CT004: Done", "CT005: Never launched"]);
  assert.deepEqual(status.all.map((row) => row.id).sort(), ["1", "4", "5"]);
  // Still only the client's own campaigns: `all` widens the statuses, never the ownership.
  assert.deepEqual(summariseCampaigns([{ id: 9, name: "Their own list", status: "FINISHED" }]).all, []);
  // And narrowing a report narrows this too, or a report scoped to one campaign would fetch three.
  assert.deepEqual(selectCampaigns(status, ["4"]).all.map((row) => row.name), ["CT004: Done"]);
  assert.deepEqual(emptyStatus("unreachable").all, []);
});

test("sender ids are carried alongside the names, because the runway is counted from them", () => {
  // A campaign with four accounts assigned and two of them named still has four days' worth of sending
  // capacity. Counting the names would halve the runway, and the ids are never printed anywhere.
  const status = summariseCampaigns(
    [{ id: 1, name: "CT001: Live", status: "IN_PROGRESS", campaignAccountIds: [11, 12, 13], progressStats: { totalUsersPending: 10 } }],
    new Map([["11", "Kori Katz"]]),
  );
  assert.deepEqual(status.active[0].senderIds, ["11", "12", "13"]);
  assert.deepEqual(status.active[0].senderNames, ["Kori Katz"]);
});

test("a campaign the client launched before hiring us is not reported at all", () => {
  // The whole point of the code prefix. These four ran before the engagement, and counting them would
  // credit us with work we did not do — and, through `launchedAt`, back-date the engagement itself.
  const pending = { progressStats: { totalUsers: 10, totalUsersPending: 10 } };
  const status = summariseCampaigns([
    { id: 1, name: "CT001: Ours", status: "IN_PROGRESS", ...pending },
    { id: 2, name: "Cotool Linkedin Followers", status: "IN_PROGRESS", ...pending },
    { id: 3, name: "Max-Test", status: "IN_PROGRESS", ...pending },
    { id: 4, name: "BH CISO & Security Leaders", status: "PAUSED", ...pending },
    { id: 5, name: "AWS re:invent 2025 New", status: "FINISHED" },
  ]);
  assert.deepEqual(status.active.map((row) => row.name), ["CT001: Ours"]);
  // Not merely unlisted — uncounted. A total of five would put four of the client's own campaigns into
  // the "campaigns we ran" figure at the top of the report.
  assert.equal(status.total, 1);
});

test("active campaigns are listed newest first", () => {
  const status = summariseCampaigns([
    { id: 1, name: "CT006: Older", status: "IN_PROGRESS", startedAt: "2026-06-01T00:00:00Z", progressStats: { totalUsersPending: 5 } },
    { id: 2, name: "CT007: Newest", status: "IN_PROGRESS", startedAt: "2026-08-09T00:00:00Z", progressStats: { totalUsersPending: 5 } },
  ]);
  assert.deepEqual(status.active.map((row) => row.name), ["CT007: Newest", "CT006: Older"]);
});

test("an unknown status with work left is reported rather than dropped", () => {
  const status = summariseCampaigns([
    { id: 9, name: "CT008: Mystery", status: "WARMING_UP", progressStats: { totalUsersPending: 40 } },
  ]);
  assert.deepEqual(status.active.map((row) => row.name), ["CT008: Mystery"]);
  assert.deepEqual(status.unrecognised, ["WARMING_UP"]);
});

test("junk in the payload cannot throw or invent a campaign", () => {
  const status = summariseCampaigns([null, "nope", 42, {}, { status: "IN_PROGRESS" }, LIVE_CAMPAIGN]);
  // The bare `{status}` row has neither id nor name, so there is nothing to report about it.
  assert.equal(status.total, 1);
  assert.equal(status.active.length, 1);
  assert.deepEqual(summariseCampaigns(undefined).active, []);
});

test("unavailable status is never mistaken for an empty workspace", () => {
  const status = emptyStatus("No HeyReach API key is saved for this client.");
  assert.equal(status.available, false);
  assert.match(status.reason, /API key/);
  assert.deepEqual(status.active, []);
  assert.deepEqual(allCampaigns(status), []);
});

test("the name index is what joins live status onto reply-derived campaign rows", () => {
  const status = summariseCampaigns([
    { id: 1, name: "W040: Website ICP Visitors", status: "IN_PROGRESS", progressStats: { totalUsersPending: 3 } },
    { id: 2, name: "W039: Ops leaders, US", status: "IN_PROGRESS", progressStats: { totalUsersPending: 0 } },
    { id: 3, name: "W012: Old list", status: "FINISHED" },
  ]);
  const index = stateByName(status);
  // Reply attribution stores the campaign name as typed, so the lookup has to be case-insensitive.
  assert.equal(index.get("w040: website icp visitors").state, "active");
  assert.equal(index.get("w039: ops leaders, us").state, "worked-through");
  // A closed campaign is not in the index, so the reply table simply shows no live state for it.
  assert.equal(index.get("w012: old list"), undefined);
  assert.equal(index.get("a campaign since renamed"), undefined);
});

test("toggling campaigns narrows the report, and no selection means all of them", () => {
  const status = summariseCampaigns([
    { id: 1, name: "CT010: Live A", status: "IN_PROGRESS", progressStats: { totalUsersPending: 5 } },
    { id: 2, name: "CT011: Live B", status: "IN_PROGRESS", progressStats: { totalUsersPending: 5 } },
    { id: 3, name: "CT003: Held", status: "PAUSED", progressStats: { totalUsersPending: 5 } },
  ]);
  assert.deepEqual(selectCampaigns(status, ["2", "3"]).active.map((row) => row.name), ["CT011: Live B"]);
  assert.deepEqual(selectCampaigns(status, ["2", "3"]).paused.map((row) => row.name), ["CT003: Held"]);
  // Absent selection is a caller that never saw the toggles; it gets the whole picture.
  assert.equal(allCampaigns(selectCampaigns(status, null)).length, 3);
  assert.equal(allCampaigns(selectCampaigns(status, undefined)).length, 3);
  // An empty selection is somebody unticking everything, which is a real answer and is obeyed.
  assert.equal(allCampaigns(selectCampaigns(status, [])).length, 0);
  // Filtering never flips availability: an empty report is not an unreachable HeyReach.
  assert.equal(selectCampaigns(status, []).available, true);
});

test("the sending runway is pending leads divided by what the senders can send in a day", () => {
  // The worked example the rule came from: 500 pending across 4 senders is 100 requests a day, so the
  // campaign has five more days of sending in it.
  assert.equal(sendingDaysLeft(500, 4), 5);
  assert.equal(sendingDaysLeft(500, 2), 10);
  assert.equal(sendingDaysLeft(500, 1), 20);
  // Rounded up, because a part-day of sending is still a day the client should expect the campaign to run.
  assert.equal(sendingDaysLeft(30, 1), 2);
  assert.equal(sendingDaysLeft(1, 4), 1);
  // Nothing left to contact is genuinely nought days, and it is the one honest zero here.
  assert.equal(sendingDaysLeft(0, 4), 0);
  // No senders is not "finishes today". It is a campaign that is not sending at all, and the answer has
  // to be that we cannot say — printing 0 would read as complete.
  assert.equal(sendingDaysLeft(500, 0), null);
  assert.equal(sendingDaysLeft(500, -1), null);
  assert.equal(sendingDaysLeft(Number.NaN, 4), null);
});

test("senders are counted from the payload and turned into a runway", () => {
  const [row] = summariseCampaigns([
    {
      id: 77,
      name: "SW021: Core ICP Retarget",
      status: "IN_PROGRESS",
      campaignAccountIds: [11, 12, 13, 14],
      progressStats: { totalUsers: 900, totalUsersPending: 500, totalUsersFinished: 400 },
    },
  ]).active;
  assert.equal(row.senders, 4);
  assert.equal(row.daysLeftInSending, 5);
});

test("a campaign HeyReach lists no senders for reports an unknown runway, not a finished one", () => {
  const [row] = summariseCampaigns([
    { id: 78, name: "CT012: Nobody assigned", status: "IN_PROGRESS", progressStats: { totalUsersPending: 500 } },
  ]).active;
  assert.equal(row.senders, 0);
  assert.equal(row.daysLeftInSending, null);
});

test("the sender list is counted whichever shape HeyReach sends it in", () => {
  // The one field here that is not verified against a captured response, so several plausible names are
  // read. Objects and bare ids both appear in HeyReach payloads depending on the endpoint.
  const shapes = [
    { campaignAccountIds: [1, 2] },
    { accountIds: ["1", "2"] },
    { linkedInSenders: [{ id: 1 }, { id: 2 }] },
    { linkedInUsers: [{ linkedInUserId: 1 }, { linkedInUserId: 2 }] },
    // The same account twice is one sender: duplicates would double the daily capacity and halve the runway.
    { campaignAccountIds: [1, 1, 2] },
  ];
  for (const shape of shapes) {
    const [row] = summariseCampaigns([
      { id: 1, name: "CT001: Live", status: "IN_PROGRESS", progressStats: { totalUsersPending: 100 }, ...shape },
    ]).active;
    assert.equal(row.senders, 2, `${JSON.stringify(shape)} should count two senders`);
    assert.equal(row.daysLeftInSending, 2);
  }
});

test("the default template layout fits the pages it claims", () => {
  // Every custom template inherits this layout, so if it overflows, every template someone writes in
  // the UI overflows with it.
  assert.ok(DEFAULT_TEMPLATE_PAGES.length <= PAGE_LIMIT);
  for (const page of DEFAULT_TEMPLATE_PAGES) {
    const { pageCount } = paginate(page);
    assert.equal(pageCount, 1, `${page.join(" + ")} should fit on one page`);
  }
  assert.equal(paginate(DEFAULT_TEMPLATE_PAGES.flat()).pageCount, PAGE_LIMIT);
  assert.ok(PAGE_CAPACITY > 0);
});
