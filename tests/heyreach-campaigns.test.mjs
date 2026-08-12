/**
 * Live campaign status.
 *
 * The classification is the whole feature: a report that tells a client "nothing is running" when
 * three campaigns are running is worse than one that says nothing at all. There is no HeyReach
 * account in CI, so the fetch is untestable here — the sorting of a real `/campaign/GetAll` payload
 * into states is what gets tested, against a fixture copied from an actual response.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyState,
  emptyStatus,
  stateByName,
  summariseCampaigns,
} from "../app/lib/heyreach-campaigns.ts";

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

test("every status HeyReach documents is recognised", () => {
  // These eight are the values the campaign list endpoint accepts as filters, so they are the full
  // vocabulary. An unrecognised one would land a live campaign in the wrong bucket.
  const expected = {
    DRAFT: "draft",
    IN_PROGRESS: "running",
    STARTING: "running",
    SCHEDULED: "scheduled",
    PAUSED: "paused",
    FINISHED: "finished",
    CANCELED: "finished",
    FAILED: "finished",
  };
  for (const [status, state] of Object.entries(expected)) {
    assert.equal(classifyState(status), state, `${status} should classify as ${state}`);
  }
});

test("status matching survives the casing and punctuation the API might use", () => {
  for (const status of ["in_progress", "In Progress", "IN-PROGRESS", " IN_PROGRESS "]) {
    assert.equal(classifyState(status), "running", `${JSON.stringify(status)} should be running`);
  }
  assert.equal(classifyState(""), "unknown");
  assert.equal(classifyState(null), "unknown");
});

test("a real campaign row is sorted into running with its progress intact", () => {
  const status = summariseCampaigns([LIVE_CAMPAIGN]);
  assert.equal(status.available, true);
  assert.equal(status.total, 1);
  assert.equal(status.running.length, 1);
  const [row] = status.running;
  assert.equal(row.id, "544987");
  assert.equal(row.name, "W040: Website ICP Visitors");
  assert.equal(row.status, "IN_PROGRESS");
  assert.equal(row.startedAt, "2026-08-10T19:17:05.558Z");
  // Progress is what makes a live-but-quiet campaign reportable rather than just absent.
  assert.deepEqual(row.progress, { total: 711, pending: 298, inProgress: 85, finished: 159 });
});

test("each state lands in its own list and drafts stay out of all of them", () => {
  const status = summariseCampaigns([
    { id: 1, name: "Live", status: "IN_PROGRESS" },
    { id: 2, name: "Next week", status: "SCHEDULED" },
    { id: 3, name: "Held", status: "PAUSED" },
    { id: 4, name: "Done", status: "FINISHED" },
    { id: 5, name: "Never launched", status: "DRAFT" },
  ]);
  assert.deepEqual(status.running.map((row) => row.name), ["Live"]);
  assert.deepEqual(status.scheduled.map((row) => row.name), ["Next week"]);
  assert.deepEqual(status.paused.map((row) => row.name), ["Held"]);
  assert.deepEqual(status.finished.map((row) => row.name), ["Done"]);
  // A draft is not a campaign the client should hear about, but it is still one in the workspace.
  assert.equal(status.total, 5);
});

test("an unknown status is treated as possibly live rather than dropped", () => {
  const status = summariseCampaigns([{ id: 9, name: "Mystery", status: "WARMING_UP" }]);
  assert.deepEqual(status.running.map((row) => row.name), ["Mystery"]);
  assert.deepEqual(status.unrecognised, ["WARMING_UP"]);
});

test("junk in the payload cannot throw or invent a campaign", () => {
  const status = summariseCampaigns([null, "nope", 42, {}, { status: "IN_PROGRESS" }, LIVE_CAMPAIGN]);
  // The bare `{status}` row has neither id nor name, so there is nothing to report about it.
  assert.equal(status.total, 1);
  assert.equal(status.running.length, 1);
  assert.deepEqual(summariseCampaigns(undefined).running, []);
});

test("unavailable status is never mistaken for an empty workspace", () => {
  const status = emptyStatus("No HeyReach API key is saved for this client.");
  assert.equal(status.available, false);
  assert.match(status.reason, /API key/);
  assert.deepEqual(status.running, []);
});

test("the name index is what joins live status onto reply-derived campaign rows", () => {
  const status = summariseCampaigns([
    { id: 1, name: "W040: Website ICP Visitors", status: "IN_PROGRESS" },
    { id: 2, name: "W012: Old list", status: "FINISHED" },
  ]);
  const index = stateByName(status);
  // Reply attribution stores the campaign name as typed, so the lookup has to be case-insensitive.
  assert.equal(index.get("w040: website icp visitors").state, "running");
  assert.equal(index.get("w012: old list").state, "finished");
  assert.equal(index.get("a campaign since renamed"), undefined);
});
