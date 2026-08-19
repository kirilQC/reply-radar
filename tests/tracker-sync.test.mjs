// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The tracker sync, tested where it decides rather than where it fetches.
 *
 * Every test below is about one of two things: a row the brief is allowed to change, or a row it is
 * not. That is the whole risk of this feature — it writes into bases other people work out of every
 * day, and it deletes. So the deletion rules and the ownership boundary get more tests than the happy
 * path does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { campaignCode, campaignState, daysBetween, normaliseKey, openItems, planCampaigns, planProjects, sameWork, STALE_DAYS } from "../app/lib/tracker-sync.ts";
import { parseTrackerItems, resolveOwner, rosterOf, TITLE_MAX } from "../app/lib/tracker-extract.ts";

/** Bluevia's real Status choices, which say "Launched" and "Completed" rather than "Active" and "Finished". */
const STATUS_CHOICES = ["Not Started", "Sent for Approval", "Launched", "On Hold", "Completed", "Cancelled"];
const PROJECT_CHOICES = {
  status: ["Not Started", "In Progress", "Blocked", "Done", "Cancelled"],
  type: ["Action Item", "Project", "Bottleneck"],
  source: ["Internal channel", "Client channel", "Call", "Manual"],
  priority: ["Urgent", "High", "Medium", "Low"],
};

const campaign = (over = {}) => ({
  name: "BV007: ASCs v2",
  status: "IN_PROGRESS",
  isActive: true,
  sent: 420,
  accepted: 118,
  replies: 24,
  pending: 106,
  senders: ["Ali", "Abhyuday", "Vijay"],
  senderCount: 3,
  daysLeft: 2,
  ...over,
});

const item = (over = {}) => ({
  title: "Add two senders to BV007",
  type: "Action Item",
  status: "Not Started",
  priority: "High",
  owner: "Kiril Ivlev",
  detail: "Kori asked on Aug 17 and the figures still show three senders.",
  source: "Internal channel",
  campaignCode: "BV007",
  key: "bv007-senders",
  ...over,
});

const row = (id, fields) => ({ id, fields });

/* ── The campaign code ──────────────────────────────────────────────────────────────────────────── */

test("the campaign code is read off the front of the name", () => {
  assert.equal(campaignCode("BV007: ASCs v2"), "BV007");
  assert.equal(campaignCode("BV001: ASC (Ortho)"), "BV001");
  assert.equal(campaignCode("WLW12 - Enterprise"), "WLW12");
});

test("a campaign named without a code gets an empty one rather than a wrong one", () => {
  // Empty falls back to matching on the title. Inventing a code here would join this campaign to
  // whichever lead table happened to share the guess.
  assert.equal(campaignCode("Social Signals"), "");
  assert.equal(campaignCode(""), "");
});

/* ── The lifecycle ──────────────────────────────────────────────────────────────────────────────── */

test("a campaign that is out of leads is finished even though HeyReach still says in progress", () => {
  // The transition the whole feature turns on. Nothing in HeyReach switches a campaign off when its
  // list runs dry, so waiting for HeyReach to say finished means never marking one finished.
  assert.equal(campaignState(campaign({ pending: 0, sent: 1_240 })), "finished");
});

test("a campaign with nothing sent and nothing pending has not started, and is left alone", () => {
  // The dangerous near miss: zero pending reads as finished if the sent figure is not checked, and a
  // campaign that has never run would be marked finished on the morning it was created.
  assert.equal(campaignState(campaign({ pending: 0, sent: 0, isActive: false, status: "DRAFT" })), null);
});

test("a live campaign with leads left is active", () => {
  assert.equal(campaignState(campaign()), "active");
});

test("a paused campaign is paused, not active and not finished", () => {
  assert.equal(campaignState(campaign({ isActive: false, status: "PAUSED" })), "paused");
});

/* ── Writing to the campaign table ──────────────────────────────────────────────────────────────── */

test("the status written is the word the base already uses, not the word we prefer", () => {
  const plan = planCampaigns([campaign()], [], STATUS_CHOICES, "2026-08-18");
  assert.equal(plan.creates[0].Status, "Launched");
});

test("a base with no word for a state keeps the status it had and says so", () => {
  // Never typecast. Adding "Active" to a client's choice set on our say-so leaves them with two words
  // for one thing in a field they group their board by.
  const plan = planCampaigns([campaign()], [], ["Not Started", "Completed"], "2026-08-18");
  assert.equal("Status" in plan.creates[0], false);
  assert.match(plan.notes[0], /no Status option meaning "active"/);
});

test("figures are still written when the status cannot be", () => {
  const plan = planCampaigns([campaign()], [], ["Not Started"], "2026-08-18");
  assert.equal(plan.creates[0]["Leads Sent"], 420);
  assert.equal(plan.creates[0]["Pending Leads"], 106);
});

test("an existing row is matched by campaign code, not by title", () => {
  // Titles get edited in Airtable. The code is the join, which is why it has its own column.
  const rows = [row("rec1", { "Campaign Code": "BV007", Title: "BV007 — ASCs, second pass" })];
  const plan = planCampaigns([campaign()], rows, STATUS_CHOICES, "2026-08-18");
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates[0].id, "rec1");
});

test("a row with no code is still matched on its title", () => {
  const rows = [row("rec2", { Title: "BV007: ASCs v2" })];
  const plan = planCampaigns([campaign()], rows, STATUS_CHOICES, "2026-08-18");
  assert.equal(plan.updates[0].id, "rec2");
});

test("an update never carries Title, Owner or Notes", () => {
  // Somebody's writing. A sync that refreshes the Notes column is a sync that deletes the sentence
  // explaining why a campaign was paused.
  const rows = [row("rec1", { "Campaign Code": "BV007", Title: "BV007: ASCs v2", Owner: "Kori Bivens", Notes: "Paused pending legal" })];
  const plan = planCampaigns([campaign()], rows, STATUS_CHOICES, "2026-08-18");
  const written = Object.keys(plan.updates[0].fields);
  assert.equal(written.includes("Title"), false);
  assert.equal(written.includes("Owner"), false);
  assert.equal(written.includes("Notes"), false);
});

test("finishing a campaign stamps the day and names it once", () => {
  const rows = [row("rec1", { "Campaign Code": "BV007" })];
  const plan = planCampaigns([campaign({ pending: 0 })], rows, STATUS_CHOICES, "2026-08-18");
  assert.equal(plan.updates[0].fields["Finished On"], "2026-08-18");
  assert.deepEqual(plan.finished, ["BV007: ASCs v2"]);
});

test("a campaign that finished last week is not re-finished every morning", () => {
  // Otherwise the finish date walks forward each run and the closing figures stop being closing
  // figures, and the brief announces the same campaign finishing three times a week.
  const rows = [row("rec1", { "Campaign Code": "BV007", "Finished On": "2026-08-11" })];
  const plan = planCampaigns([campaign({ pending: 0 })], rows, STATUS_CHOICES, "2026-08-18");
  assert.equal("Finished On" in plan.updates[0].fields, false);
  assert.deepEqual(plan.finished, []);
});

test("leads added to a finished campaign reopen it and clear the finish date", () => {
  const rows = [row("rec1", { "Campaign Code": "BV007", "Finished On": "2026-08-11" })];
  const plan = planCampaigns([campaign({ pending: 300 })], rows, STATUS_CHOICES, "2026-08-18");
  assert.equal(plan.updates[0].fields.Status, "Launched");
  assert.equal(plan.updates[0].fields["Finished On"], null);
});

test("a row for a campaign the brief did not see is not touched at all", () => {
  // A campaign outside the ten the brief reports, or one archived in HeyReach. Refreshing it from
  // figures we do not have would zero its numbers.
  const rows = [row("rec1", { "Campaign Code": "BV001" }), row("rec2", { "Campaign Code": "BV007" })];
  const plan = planCampaigns([campaign()], rows, STATUS_CHOICES, "2026-08-18");
  assert.deepEqual(plan.updates.map((update) => update.id), ["rec2"]);
});

test("senders are written by name and left blank when there are none", () => {
  const named = planCampaigns([campaign()], [], STATUS_CHOICES, "2026-08-18");
  assert.equal(named.creates[0].Senders, "Ali, Abhyuday, Vijay");
  // Three senders whose names are not recorded. The count belongs in the brief; an id must never end
  // up in a column a person reads as a name.
  const unnamed = planCampaigns([campaign({ senders: [], senderCount: 3 })], [], STATUS_CHOICES, "2026-08-18");
  assert.equal(unnamed.creates[0].Senders, "");
});

/* ── Writing to the project table ───────────────────────────────────────────────────────────────── */

test("a new item is created with the ownership checkbox ticked", () => {
  const plan = planProjects([item()], [], PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.equal(plan.creates[0]["Raised by Brief"], true);
  assert.equal(plan.creates[0]["First Raised"], "2026-08-18");
  assert.equal(plan.creates[0]["Last Seen"], "2026-08-18");
});

test("the same item on a later brief updates its row instead of adding a second", () => {
  const rows = [row("rec1", { "Brief Key": "bv007-senders", "Raised by Brief": true, "Last Seen": "2026-08-14" })];
  const plan = planProjects([item({ title: "Still missing two senders on BV007" })], rows, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates[0].id, "rec1");
  assert.equal(plan.updates[0].fields["Last Seen"], "2026-08-18");
});

test("an old dated key still finds its row, so the first run after the change does not duplicate", () => {
  const rows = [row("rec1", { "Brief Key": "bluevia:2026-08-18:bv007-senders", "Raised by Brief": true, "Last Seen": "2026-08-18" })];
  const plan = planProjects([item()], rows, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates[0].id, "rec1");
});

test("a row nobody's brief created is never updated and never deleted", () => {
  // The single most important test in this file. Without the checkbox this is a scheduled job that
  // deletes a colleague's notes.
  const rows = [row("rec1", { "Brief Key": "bv007-senders", "Last Seen": "2026-01-01" })];
  const plan = planProjects([item()], rows, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.deepEqual(plan.deletes, []);
  assert.deepEqual(plan.updates, []);
  // It is treated as absent, so the item lands as the brief's own row alongside it.
  assert.equal(plan.creates.length, 1);
});

test("an item that has dropped out of the brief survives one quiet morning", () => {
  // A model having a thin run, or a Slack read that failed, must not be destructive.
  const rows = [row("rec1", { "Brief Key": "gone-quiet", "Raised by Brief": true, "Last Seen": "2026-08-17" })];
  const plan = planProjects([], rows, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.deepEqual(plan.deletes, []);
});

test("an item that has dropped out for the whole wait is removed", () => {
  const rows = [row("rec1", { "Brief Key": "gone-quiet", "Raised by Brief": true, "Last Seen": "2026-08-13" })];
  const plan = planProjects([], rows, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.deepEqual(plan.deletes, ["rec1"]);
  assert.equal(daysBetween("2026-08-13", "2026-08-18"), STALE_DAYS);
});

test("an item somebody marked Done goes immediately, without the wait", () => {
  // A person saying it is finished is not the same signal as silence, and does not need guarding
  // against a bad model run.
  const rows = [row("rec1", { "Brief Key": "done-today", "Raised by Brief": true, "Last Seen": "2026-08-18", Status: { name: "Done" } })];
  const plan = planProjects([], rows, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.deepEqual(plan.deletes, ["rec1"]);
});

test("an item marked Done but still raised by the brief stays, because the brief still sees it open", () => {
  const rows = [row("rec1", { "Brief Key": "bv007-senders", "Raised by Brief": true, "Last Seen": "2026-08-18", Status: { name: "Done" } })];
  const plan = planProjects([item()], rows, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.deepEqual(plan.deletes, []);
});

test("a row with no Last Seen falls back to when it was first raised rather than living forever", () => {
  const rows = [row("rec1", { "Brief Key": "orphan", "Raised by Brief": true, "First Raised": "2026-07-01" })];
  const plan = planProjects([], rows, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.deepEqual(plan.deletes, ["rec1"]);
});

test("an item is linked to its campaign only when that campaign has a row", () => {
  const linked = planProjects([item()], [], PROJECT_CHOICES, new Map([["BV007", "recCamp"]]), "2026-08-18");
  assert.deepEqual(linked.creates[0].Campaign, ["recCamp"]);
  // A code with no row behind it links to nothing. The campaign table is fed from HeyReach, and one
  // invented from a mention in a brief would be a campaign that does not exist.
  const unlinked = planProjects([item({ campaignCode: "BV999" })], [], PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.equal("Campaign" in unlinked.creates[0], false);
});

test("a value the base has no option for is left unwritten rather than typecast into existence", () => {
  const plan = planProjects([item({ type: "Bottleneck" })], [], { ...PROJECT_CHOICES, type: ["Action Item"] }, new Map(), "2026-08-18");
  assert.equal("Type" in plan.creates[0], false);
  assert.equal(plan.creates[0].Status, "Not Started");
});

test("normalising a key strips punctuation so two spellings of one slug are one row", () => {
  assert.equal(normaliseKey("BV007 Senders"), "bv007-senders");
  assert.equal(normaliseKey("client:2026-08-18:bv007-senders"), "bv007-senders");
  assert.equal(normaliseKey(""), "");
});

/* ── Reading the items out of the brief ─────────────────────────────────────────────────────────── */

test("a fenced JSON block is read, because models fence it about one run in ten", () => {
  const items = parseTrackerItems('```json\n{"items":[{"title":"Chase the surgeon list","key":"surgeon-list"}]}\n```');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Chase the surgeon list");
});

test("output that is not JSON at all yields nothing rather than throwing", () => {
  // This runs after the brief has been posted. Nothing here may turn a delivered brief into a failure.
  assert.deepEqual(parseTrackerItems("I could not find any action items."), []);
});

test("an item with no key is dropped, because it could never be found again", () => {
  // Keeping it would mean creating a fresh copy of it every morning.
  assert.deepEqual(parseTrackerItems('{"items":[{"title":"Something"}]}'), []);
});

test("two items sharing a key become one row", () => {
  const items = parseTrackerItems('{"items":[{"title":"A","key":"same"},{"title":"B","key":"same"}]}');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "A");
});

test("a long title is cut at a word boundary, because the gallery shows the title and little else", () => {
  const long = "Continue enriching the Doximity list so the first Doximity campaign can be built and launched";
  const items = parseTrackerItems(JSON.stringify({ items: [{ title: long, key: "doximity" }] }));
  assert.ok(items[0].title.length <= TITLE_MAX);
  assert.equal(items[0].title.endsWith(" "), false);
  assert.ok(long.startsWith(items[0].title));
});

test("an at sign left on an owner is stripped, so the column can be grouped on", () => {
  const items = parseTrackerItems('{"items":[{"title":"T","key":"k","owner":"@Kiril Ivlev"}]}');
  assert.equal(items[0].owner, "Kiril Ivlev");
});

test("a title long enough to be cut off on a gallery card is not accepted", () => {
  /*
   * The cap is the whole point of the column, so it is asserted as a number rather than only as a
   * bound: a card gives the title two lines and then an ellipsis, and the first version shipped at 64
   * and filled the board with "Pin down Morgan Rose on upgrading to LinkedI…".
   */
  assert.equal(TITLE_MAX, 40);
  const real = "Pin down Morgan Rose on upgrading to LinkedIn Sales Navigator";
  const items = parseTrackerItems(JSON.stringify({ items: [{ title: real, key: "morgan-navigator" }] }));
  assert.ok(items[0].title.length <= 40, `"${items[0].title}" is still ${items[0].title.length} characters`);
});

/* ── The same work under a different name ──────────────────────────────────────────────────────── */

/*
 * Every pair below is a real one. The first tracker run against Ema Health filed nine items; changing
 * the prompt that writes the titles re-slugged all nine, and the next run filed a second copy of every
 * one of them rather than updating any. These are those nine titles, before and after.
 */
const REWORDED = [
  ["Upgrade Morgan Rose LinkedIn Premium", "Pin down Morgan Rose on upgrading to LinkedIn Premium"],
  ["Investigate HubSpot bounce issue", "Investigate HubSpot email bounce issue and confirm the domain warmup"],
  ["Mark up messaging doc with brand voice", "Mark up proposed messaging doc with the new brand voice"],
  ["Review Ema list and send sender split", "Review 534-contact Ema list and hand over sender split"],
  ["Segment list and build HeyReach campaign", "Segment contact list by persona and build the first campaign"],
];

test("a title the model reworded still finds the row it belongs to", () => {
  for (const [now, before] of REWORDED) {
    assert.equal(sameWork(now, before), true, `"${now}" did not match "${before}"`);
  }
});

test("two campaigns are not one item however alike the sentence is", () => {
  // The failure that matters in the other direction. A false merge silently loses an item, which is
  // worse than the duplicate this whole mechanism exists to prevent.
  assert.equal(sameWork("Add two senders to BV007", "Add two senders to BV009"), false);
  assert.equal(sameWork("Launch W003", "Launch W004"), false);
});

test("two genuinely different items are left apart", () => {
  assert.equal(sameWork("Schedule onboarding call with Stephanie", "Investigate HubSpot bounce issue"), false);
  assert.equal(sameWork("Share Figma mockups of Ema build", "Chase the surgeon offices list"), false);
  assert.equal(sameWork("", "Anything at all"), false);
});

test("a reworded item updates its row instead of filing a second copy", () => {
  const board = [row("rec1", { "Brief Key": "hubspot-email-bounce-issue", Title: "Investigate HubSpot email bounce issue and confirm the domain warmup", "Raised by Brief": true, "Last Seen": "2026-08-18" })];
  const plan = planProjects([item({ key: "hubspot-bounce", title: "Investigate HubSpot bounce issue" })], board, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0].id, "rec1");
  // The row takes the new key, so the next run matches on the key and never reaches the fuzzy path.
  assert.equal(plan.updates[0].fields["Brief Key"], "hubspot-bounce");
  assert.deepEqual(plan.deletes, []);
});

test("a duplicate already on the board is merged away now, not in five days", () => {
  /*
   * The state Ema Health was actually left in: the same work under two keys. One row survives with
   * today's wording and the other goes immediately — a copy is not evidence of anything, and waiting
   * out the stale window would leave the flooded view up for the whole wait.
   */
  const board = [
    row("recOld", { "Brief Key": "hubspot-email-bounce-issue", Title: "Investigate HubSpot email bounce issue and confirm the domain warmup", "Raised by Brief": true, "Last Seen": "2026-08-18" }),
    row("recNew", { "Brief Key": "hubspot-bounce", Title: "Investigate HubSpot bounce issue", "Raised by Brief": true, "Last Seen": "2026-08-18" }),
  ];
  const plan = planProjects([item({ key: "hubspot-bounce", title: "Investigate HubSpot bounce issue" })], board, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.equal(plan.creates.length, 0);
  // The keyed row is the one kept, so the key the model just used stays the key on the board.
  assert.equal(plan.updates[0].id, "recNew");
  assert.deepEqual(plan.deletes, ["recOld"]);
  assert.match(plan.notes.join(" "), /duplicate row/);
});

test("a duplicate is reported as a duplicate and not as work that finished", () => {
  const board = [
    row("recA", { "Brief Key": "a", Title: "Investigate HubSpot bounce issue", "Raised by Brief": true, "Last Seen": "2026-08-18" }),
    row("recB", { "Brief Key": "b", Title: "Investigate HubSpot email bounce issue", "Raised by Brief": true, "Last Seen": "2026-08-18" }),
    row("recGone", { "Brief Key": "gone", Title: "Chase the surgeon offices list", "Raised by Brief": true, "Last Seen": "2026-08-01" }),
  ];
  const plan = planProjects([item({ key: "a", title: "Investigate HubSpot bounce issue" })], board, PROJECT_CHOICES, new Map(), "2026-08-18");
  const notes = plan.notes.join(" ");
  assert.match(notes, /1 item the brief raised stopped appearing/);
  assert.match(notes, /1 duplicate row/);
  assert.equal(plan.deletes.length, 2);
});

test("one row is only ever claimed by one item", () => {
  // Two items that both look like the row would otherwise update it twice and delete it as a copy of
  // itself, which is a plan that cannot be executed.
  const board = [row("rec1", { "Brief Key": "senders", Title: "Add two senders to BV007", "Raised by Brief": true, "Last Seen": "2026-08-18" })];
  const plan = planProjects(
    [item({ key: "senders", title: "Add two senders to BV007" }), item({ key: "senders-again", title: "Add the two senders to BV007" })],
    board,
    PROJECT_CHOICES,
    new Map(),
    "2026-08-18",
  );
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.creates.length, 1);
  assert.deepEqual(plan.deletes, []);
});

test("a hand-typed row is never merged into a brief item, however alike the titles are", () => {
  // The ownership boundary outranks the matching. Somebody's own note is not a duplicate of ours.
  const board = [row("recTheirs", { "Brief Key": "", Title: "Investigate HubSpot email bounce issue", "Raised by Brief": false })];
  const plan = planProjects([item({ key: "hubspot-bounce", title: "Investigate HubSpot bounce issue" })], board, PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.equal(plan.creates.length, 1);
  assert.deepEqual(plan.updates, []);
  assert.deepEqual(plan.deletes, []);
});

/* ── What the model is shown of the board ──────────────────────────────────────────────────────── */

test("the board handed to the model is the brief's own rows, under the keys it matches on", () => {
  const open = openItems([
    row("rec1", { "Brief Key": "client:2026-08-18:surgeon-offices", Title: "Chase surgeon offices list", Owner: "Kiril Ivlev", "Raised by Brief": true }),
    row("rec2", { "Brief Key": "theirs", Title: "Somebody's own note", "Raised by Brief": false }),
    row("rec3", { "Brief Key": "", Title: "No key at all", "Raised by Brief": true }),
  ]);
  // The dated prefix is stripped, because the key the model copies back is the key `planProjects`
  // compares — handing over the raw one would guarantee a miss on every old row.
  assert.deepEqual(open, [{ key: "surgeon-offices", title: "Chase surgeon offices list", owner: "Kiril Ivlev" }]);
});

/* ── Owners are people, not user ids ───────────────────────────────────────────────────────────── */

test("a Slack mention code becomes the person's name", () => {
  // The brief is written for Slack, so every owner in it arrives as `<@U…>`. Left alone, the Owner
  // column reads U0A2TQ1V49Y, which is what the client's tracker actually filled up with.
  const names = rosterOf([{ id: "U0A2TQ1V49Y", name: "Kiril Ivlev" }]);
  const items = parseTrackerItems('{"items":[{"title":"T","key":"k","owner":"<@U0A2TQ1V49Y>"}]}', names);
  assert.equal(items[0].owner, "Kiril Ivlev");
});

test("a bare user id with the brackets already stripped off is still resolved", () => {
  const names = rosterOf([{ id: "U09BWJMV8DT", name: "Dan Cole" }]);
  assert.equal(resolveOwner("U09BWJMV8DT", names), "Dan Cole");
  assert.equal(resolveOwner("@U09BWJMV8DT", names), "Dan Cole");
  assert.equal(resolveOwner("<@U09BWJMV8DT|dan>", names), "Dan Cole");
});

test("an id nobody can name is dropped rather than written through", () => {
  // A column of ids cannot be read or grouped on, and it is not a better answer than blank — it is a
  // different question. Blank says the brief named nobody we can identify, which is true.
  assert.equal(resolveOwner("<@UNKNOWN12345>", new Map()), "");
});

test("one unknown id among two owners leaves the other one standing", () => {
  const names = rosterOf([{ id: "U0A2TQ1V49Y", name: "Kiril Ivlev" }]);
  assert.equal(resolveOwner("<@U0A2TQ1V49Y>, <@UGHOST99999>", names), "Kiril Ivlev");
  assert.equal(resolveOwner("<@UGHOST99999>, <@U0A2TQ1V49Y>", names), "Kiril Ivlev");
});

test("a group name that is not a person is left exactly as it is", () => {
  // "QC Campaign Approval and Launch" is a real owner in the brief and has no user id behind it.
  assert.equal(resolveOwner("QC Campaign Approval and Launch", new Map()), "QC Campaign Approval and Launch");
});

test("a campaign code in an owner is not mistaken for a user id", () => {
  assert.equal(resolveOwner("BV007 owners", new Map()), "BV007 owners");
});

test("the roster keeps the first name given for an id and ignores half-filled entries", () => {
  const names = rosterOf([{ id: "U1", name: "First" }, { id: "U1", name: "Second" }, { id: "", name: "Nobody" }, { id: "U2", name: "" }]);
  assert.deepEqual([...names], [["U1", "First"]]);
});

/* ── Priority ──────────────────────────────────────────────────────────────────────────────────── */

test("an item with no priority is Medium, because an empty column cannot be sorted on", () => {
  const items = parseTrackerItems('{"items":[{"title":"T","key":"k"}]}');
  assert.equal(items[0].priority, "Medium");
  assert.equal(parseTrackerItems('{"items":[{"title":"T","key":"k","priority":"P1"}]}')[0].priority, "Medium");
});

test("the priority reaches the row", () => {
  const plan = planProjects([item({ priority: "Urgent" })], [], PROJECT_CHOICES, new Map(), "2026-08-18");
  assert.equal(plan.creates[0].Priority, "Urgent");
});

test("a base with no Priority field gets no Priority key rather than a rejected write", () => {
  // Without `typecast` Airtable refuses a value that is not an option and fails the whole record, so
  // an unwritable priority would take the title and the detail down with it.
  const plan = planProjects([item()], [], { ...PROJECT_CHOICES, priority: [] }, new Map(), "2026-08-18");
  assert.equal("Priority" in plan.creates[0], false);
  assert.equal(plan.creates[0].Title, "Add two senders to BV007");
});

test("a choice is written in the base's own spelling, not ours", () => {
  const plan = planProjects([item({ priority: "High", type: "Bottleneck" })], [], { ...PROJECT_CHOICES, priority: ["urgent", "high"], type: ["bottleneck"] }, new Map(), "2026-08-18");
  assert.equal(plan.creates[0].Priority, "high");
  assert.equal(plan.creates[0].Type, "bottleneck");
});

test("a type or status the tracker has no column value for falls back rather than being written through", () => {
  const items = parseTrackerItems('{"items":[{"title":"T","key":"k","type":"Epic","status":"Shipped","source":"Email"}]}');
  assert.equal(items[0].type, "Action Item");
  assert.equal(items[0].status, "Not Started");
  assert.equal(items[0].source, "Internal channel");
});

test("an owner the brief did not name comes back empty, never guessed", () => {
  const items = parseTrackerItems('{"items":[{"title":"T","key":"k"}]}');
  assert.equal(items[0].owner, "");
});
