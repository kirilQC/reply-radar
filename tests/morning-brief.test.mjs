// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The morning brief, and the two things about it that would go wrong quietly.
 *
 * A brief is read once, over coffee, by people who already know the account. That is exactly the
 * audience least likely to check a figure — so a wrong number does not get caught, it gets acted on.
 * The defence is that the model is never asked to produce one: everything a brief states as fact is
 * computed here and handed over as prose. These tests are about that computation, and about the
 * channel ids that decide where the result lands.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { looksLikeChannelId, normalizeChannelId } from "../app/lib/slack-channel.ts";
import { briefFraming, briefHeaderText, briefTrace, briefWeekdayNote, briefWithFooter, DEFAULT_MORNING_BRIEF_PROMPT, gatherSignals, signalsAsText, briefUserContent, morningBriefPromptKey } from "../app/lib/morning-brief.ts";
import { transcript } from "../app/lib/slack.ts";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/slack/brief/route.ts", import.meta.url), "utf8");
// `morning-brief-run.ts` imports its neighbours by relative path, which Node's type-stripping cannot
// resolve at runtime, so the parts of it that cannot be imported are asserted on as source.
const runFile = readFileSync(new URL("../app/lib/morning-brief-run.ts", import.meta.url), "utf8");
const slackLib = readFileSync(new URL("../app/lib/slack.ts", import.meta.url), "utf8");

const WORKSPACE = { id: "w1", name: "Willow", slug: "willow", timezone: "America/New_York" };

/**
 * A reader that answers the three reads `gatherSignals` makes, keyed on which table was asked for.
 *
 * The two `rr_daily_stats` reads are told apart on `sender_id`: the empty one is the workspace total and
 * the `neq.` one is the per-sender rows, which exist only to put names on the ids the campaigns carry.
 */
const readerFor = (campaigns, days, senders = []) => async (path) => {
  if (path.startsWith("rr_campaign_stats")) return campaigns;
  if (path.includes("sender_id=neq.")) return senders;
  if (path.startsWith("rr_daily_stats")) return days;
  throw new Error(`unexpected read: ${path}`);
};

/** `n` days counting back from `startDaysAgo`, each with the same figures. */
const dayRows = (startDaysAgo, count, sent, accepted = 0, replies = 0) =>
  Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, 31) - (startDaysAgo + index) * 86_400_000);
    return { day: date.toISOString().slice(0, 10), connections_sent: sent, connections_accepted: accepted, replies };
  });

test("a channel id is read out of whatever was pasted", () => {
  assert.equal(normalizeChannelId("C09ABCDEF"), "C09ABCDEF");
  assert.equal(normalizeChannelId("  c09abcdef  "), "C09ABCDEF");
  // The commonest paste by far: the address bar, with the message timestamp still on the end.
  assert.equal(normalizeChannelId("https://qcagency.slack.com/archives/C09ABCDEF/p1700000000000000"), "C09ABCDEF");
  // A channel name is left as typed rather than upper-cased into something that looks like an id. It is
  // still wrong, and `looksLikeChannelId` is what says so.
  assert.equal(normalizeChannelId("#willow-internal"), "willow-internal");
  assert.equal(normalizeChannelId(""), "");
  assert.equal(normalizeChannelId(undefined), "");
});

test("a channel name is not mistaken for a channel id", () => {
  // This is the mistake worth catching: a name saves without complaint and then resolves to nothing,
  // so the brief goes nowhere and nothing on the page looks broken.
  assert.equal(looksLikeChannelId("C09ABCDEF"), true);
  assert.equal(looksLikeChannelId("G01AB2CD3EF"), true);
  assert.equal(looksLikeChannelId("willow-internal"), false);
  assert.equal(looksLikeChannelId("C09"), false);
  assert.equal(looksLikeChannelId(""), false);
});

test("the two windows are seven days each and back to back", async () => {
  // 14 straight days of sends, the first week twice the second. If the windows overlapped or slipped,
  // neither figure would come out round.
  const days = [...dayRows(0, 7, 100), ...dayRows(7, 7, 50)];
  const signals = await gatherSignals(readerFor([], days), WORKSPACE);
  assert.equal(signals.sending.thisWeek, 700);
  assert.equal(signals.sending.lastWeek, 350);
  assert.equal(signals.sending.changePercent, 100);
});

test("quiet days are counted from the last day with sends, not from today", async () => {
  // A client that stopped a fortnight ago has to read as a fortnight. Counting from today would make
  // every stalled account report zero quiet days, which is the opposite of the truth.
  const days = [...dayRows(0, 10, 0), ...dayRows(10, 4, 80)];
  const signals = await gatherSignals(readerFor([], days), WORKSPACE);
  assert.ok(signals.sending.quietDays >= 10, `expected at least 10 quiet days, got ${signals.sending.quietDays}`);
  assert.equal(signals.sending.thisWeek, 0);
  assert.ok(signals.sending.lastWeek > 0, "the previous window still has the sends in it");
});

test("a client with no figures at all says so instead of reading as zero", async () => {
  const signals = await gatherSignals(readerFor([], []), WORKSPACE);
  assert.equal(signals.staleness.statsAgeHours, null);
  assert.equal(signals.staleness.dayCount, 0);
  const text = signalsAsText(signals);
  assert.match(text, /No figures have ever been collected/i);
  // "Nothing was sent" and "we have no data" are completely different briefs, and only one of them is
  // somebody's fault. The text must not offer a figure it does not have.
  assert.doesNotMatch(text, /Connection requests sent in the last 7 days/);
});

test("real sending is reported even when no campaign row carries a timestamp", async () => {
  // The regression this exists for: the "nothing is known" line was gated on the campaign refresh time,
  // so a client whose daily figures had arrived but whose campaign rows had not got a brief saying no
  // figures existed — while a week of real sending sat in the table.
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100, 40, 6)), WORKSPACE);
  const text = signalsAsText(signals);
  assert.doesNotMatch(text, /No figures have ever been collected/i);
  assert.match(text, /Connection requests sent in the last 7 days: 700/);
  assert.match(text, /Replies in the last 7 days: 42/);
  // And it says which part is missing, rather than implying the breakdown is empty.
  assert.match(text, /No campaign records have been collected/);
});

test("campaign counts come from the statuses, not from the row count", async () => {
  const campaigns = [
    { name: "Founders — NY", status: "ACTIVE", connections_sent: 400, connections_accepted: 120, replies: 30, leads_pending: 900, refreshed_at: new Date().toISOString() },
    { name: "Ops leads", status: "PAUSED", connections_sent: 120, connections_accepted: 20, replies: 2, leads_pending: 0, refreshed_at: new Date().toISOString() },
    { name: "Old test", status: "FINISHED", connections_sent: 10, connections_accepted: 1, replies: 0, leads_pending: 0, refreshed_at: new Date().toISOString() },
  ];
  const signals = await gatherSignals(readerFor(campaigns, dayRows(0, 7, 50)), WORKSPACE);
  assert.equal(signals.campaigns.total, 3);
  assert.equal(signals.campaigns.active, 1);
  assert.equal(signals.campaigns.paused, 1);
  assert.equal(signals.campaigns.finished, 1);
  assert.equal(signals.campaigns.names[0].name, "Founders — NY");
});

/**
 * The status HeyReach actually sends for a running campaign, which is not the one the first version of
 * this matched. A real Bluevia run read thirteen campaigns and reported "0 active, 2 paused" — the two
 * `IN_PROGRESS` ones fell through every bucket, and nine finished ones were never counted at all.
 */
test("a running campaign is counted however HeyReach spells the status", async () => {
  const sent = { connections_sent: 100, connections_accepted: 10, replies: 1, leads_pending: 50, refreshed_at: new Date().toISOString() };
  const signals = await gatherSignals(
    readerFor([
      { name: "BV006", status: "IN_PROGRESS", ...sent },
      { name: "BV007", status: "in progress", ...sent },
      { name: "BV008", status: "IN-PROGRESS", ...sent },
      { name: "BV009", status: "PAUSED", ...sent },
      { name: "BV010", status: "FINISHED", ...sent },
    ], dayRows(0, 7, 50)),
    WORKSPACE,
  );
  assert.equal(signals.campaigns.active, 3);
  // Every campaign lands in exactly one bucket, so the three add up to the total. A line that says
  // "13 campaigns, 0 active, 2 paused" leaves eleven unexplained and reads as a bug in the report.
  const { total, active, paused, finished } = signals.campaigns;
  assert.equal(active + paused + finished, total);
});

// ── Where the figures came from ──────────────────────────────────────
//
// The brief is read three mornings a week by people sitting next to HeyReach's own screen, so it now asks
// HeyReach during the run rather than printing the copy the overnight worker took. That copy is refreshed
// one client per cycle on a 24-hour cadence, which is how a brief came to state a pending-lead count a
// full day of sending out of date.
//
// It is still there for the run where HeyReach cannot be reached inside the sixty seconds the route has.
// These tests are about the one rule that makes that safe: the fallback is announced, never silent, and
// the two sources are summed by the same code so a fallback run differs only in what it says about itself.

/** Shaped like `CampaignFacts` — what either source hands over before the brief's wording is applied. */
const facts = (over) => ({
  name: "W040: Website ICP Visitors",
  status: "IN_PROGRESS",
  isActive: true,
  sent: 0,
  accepted: 0,
  replies: 0,
  pending: 0,
  total: 0,
  launchedAt: "",
  senders: [],
  senderIds: [],
  ...over,
});

/** The same days `dayRows` builds, in the shape HeyReach's series arrives in. */
const liveDays = (startDaysAgo, count, sent, accepted = 0, replies = 0) =>
  dayRows(startDaysAgo, count, sent, accepted, replies).map((row) => ({
    day: row.day,
    sent: row.connections_sent,
    accepted: row.connections_accepted,
    replies: row.replies,
  }));

test("a live read does not touch the stored tables at all", async () => {
  // Not as a cross-check and not as a fallback for the odd missing field. Two sources for one figure means
  // the brief eventually states the wrong one and nobody can tell which.
  const refuse = async (path) => {
    throw new Error(`the stored tables must not be read on a live run: ${path}`);
  };
  const signals = await gatherSignals(refuse, WORKSPACE, {
    available: true,
    reason: "",
    campaigns: [facts({ sent: 400, accepted: 120, replies: 30, pending: 900, senderIds: ["11", "12"] })],
    days: liveDays(0, 7, 100, 40, 6),
  });
  assert.equal(signals.source.live, true);
  assert.equal(signals.source.reason, "");
  assert.equal(signals.campaigns.total, 1);
  assert.equal(signals.sending.thisWeek, 700);
  assert.equal(signals.replies.thisWeek, 42);
  assert.equal(signals.runway.pending, 900);
  assert.equal(signals.runway.senders, 2);
});

test("a live read carries the launch date and the list size through to the campaign row", async () => {
  // The two the Airtable timeline is drawn from. They ride from HeyReach's own figures straight into the
  // per-campaign record the tracker sync writes, untouched by the brief's prose.
  const refuse = async (path) => {
    throw new Error(`the stored tables must not be read on a live run: ${path}`);
  };
  const signals = await gatherSignals(refuse, WORKSPACE, {
    available: true,
    reason: "",
    campaigns: [facts({ total: 640, launchedAt: "2026-08-04T09:12:00.000Z" })],
    days: liveDays(0, 7, 100, 40, 6),
  });
  assert.equal(signals.campaigns.names[0].total, 640);
  assert.equal(signals.campaigns.names[0].launchDate, "2026-08-04T09:12:00.000Z");
});

test("a client with no campaigns of ours is a live answer, not a reason to read the copy", async () => {
  const refuse = async (path) => {
    throw new Error(`unexpected read: ${path}`);
  };
  const signals = await gatherSignals(refuse, WORKSPACE, { available: true, reason: "", campaigns: [], days: [] });
  assert.equal(signals.source.live, true);
  assert.equal(signals.campaigns.total, 0);
  // And it is not told to ask for campaigns, because there is no engagement here to have run dry.
  assert.equal(signals.runway.needsCampaigns, false);
});

test("both sources are summed by the same code, so a fallback changes only its provenance", async () => {
  // The point of one composer. If the arithmetic were duplicated, the morning HeyReach was unreachable
  // would change the numbers as well as the caveat, and the caveat is the only part anybody would see.
  const refreshed = new Date(Date.now() - 26 * 3_600_000).toISOString();
  const stored = await gatherSignals(
    readerFor(
      [{ name: "W040: Website ICP Visitors", status: "IN_PROGRESS", connections_sent: 400, connections_accepted: 120, replies: 30, leads_pending: 900, sender_ids: ["11", "12"], refreshed_at: refreshed }],
      dayRows(0, 7, 100, 40, 6),
    ),
    WORKSPACE,
    { available: false, reason: "HeyReach campaign stats returned 502", campaigns: [], days: [] },
  );
  const live = await gatherSignals(
    async (path) => {
      throw new Error(`unexpected read: ${path}`);
    },
    WORKSPACE,
    {
      available: true,
      reason: "",
      campaigns: [facts({ sent: 400, accepted: 120, replies: 30, pending: 900, senderIds: ["11", "12"] })],
      days: liveDays(0, 7, 100, 40, 6),
    },
  );
  assert.deepEqual(
    { ...stored, source: null, staleness: null },
    { ...live, source: null, staleness: null },
  );
  assert.equal(stored.source.live, false);
  assert.equal(stored.source.reason, "HeyReach campaign stats returned 502");
  assert.equal(stored.staleness.statsAgeHours, 26);
});

test("a run on the stored copy says so in the figures, with the reason", async () => {
  const signals = await gatherSignals(
    readerFor([{ name: "W040", status: "IN_PROGRESS", connections_sent: 10, connections_accepted: 4, replies: 1, leads_pending: 20, refreshed_at: new Date(Date.now() - 26 * 3_600_000).toISOString() }], dayRows(0, 7, 50)),
    WORKSPACE,
    { available: false, reason: "The operation was aborted due to timeout", campaigns: [], days: [] },
  );
  const text = signalsAsText(signals);
  assert.match(text, /comes from our own stored copy rather than from HeyReach/);
  assert.match(text, /last collected 26 hours ago/);
  assert.match(text, /The operation was aborted due to timeout/);
  // And the model is told to say it once, not against every campaign, or the brief reads as a disclaimer.
  assert.match(text, /Do not repeat it per campaign/);
});

test("no API key is a different sentence from HeyReach failing", async () => {
  // The two send whoever reads the brief to two different places: one is a config page, the other is a
  // service having a bad morning. A single "figures may be stale" line would conflate them.
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 50)), WORKSPACE, { available: false, reason: "", campaigns: [], days: [] });
  assert.match(signalsAsText(signals), /HeyReach was not asked, because no API key is saved for this client/);
});

test("a live read says it is current, and says it once", async () => {
  const signals = await gatherSignals(
    async (path) => {
      throw new Error(`unexpected read: ${path}`);
    },
    WORKSPACE,
    { available: true, reason: "", campaigns: [facts({ sent: 10, accepted: 4, pending: 20 })], days: liveDays(0, 7, 50) },
  );
  const text = signalsAsText(signals);
  assert.match(text, /read from HeyReach just now/);
  assert.doesNotMatch(text, /stored copy/);
  assert.doesNotMatch(text, /last collected/);
});

test("the live fetch is all three calls or none of them", () => {
  /*
   * A partial live read is the worst option available. Without the rollup every campaign reports 0 sent
   * and 0 accepted; without the series the brief states that nothing has been sent in three weeks. Both
   * are confidently wrong in the direction that starts a conversation about a dead account, and neither is
   * distinguishable in the output from the truth.
   */
  assert.match(runFile, /if \(!funnel\.available\) return nothing\(/);
  assert.match(runFile, /if \(!days\) return nothing\(/);
  // Scoped to this client's own campaigns on every call. An empty id list would read as "the whole
  // account", which counts the outbound a client ran before the engagement as ours.
  assert.match(runFile, /campaignFunnelFor\(key, ids,/);
  assert.match(runFile, /dailyStatsFor\(key, ids,/);
  // And it is asked for before the stored reads, because its answer decides whether they happen.
  assert.match(route, /const live = await gatherLiveFigures\(/);
  assert.match(route, /gatherSignals\(read, workspace, live\)/);
});

// ── The sending runway ───────────────────────────────────────────────
//
// The one figure in the brief that is meant to start work today: how many days of sending are left before
// the client runs out of leads. It is the proactive half of the brief, and getting it wrong in either
// direction is expensive — too high and nobody builds anything until the account goes quiet, too low and
// the team is told to build campaigns it does not need.

test("days of sending left divide the pending leads by the whole sender bench", async () => {
  // 600 pending across four senders at 25 a day each is 100 a day, so six days. The senders overlap on
  // purpose: two campaigns on the same four accounts have four between them, not eight, and summing the
  // per-campaign runways would report twice the runway the client actually has.
  const signals = await gatherSignals(
    readerFor([
      { name: "BV011", status: "IN_PROGRESS", connections_sent: 300, connections_accepted: 60, replies: 5, leads_pending: 400, sender_ids: ["s1", "s2", "s3", "s4"], refreshed_at: new Date().toISOString() },
      { name: "BV012", status: "IN_PROGRESS", connections_sent: 100, connections_accepted: 20, replies: 1, leads_pending: 200, sender_ids: ["s1", "s2"], refreshed_at: new Date().toISOString() },
      { name: "BV009", status: "PAUSED", connections_sent: 50, connections_accepted: 5, replies: 0, leads_pending: 5_000, sender_ids: ["s1"], refreshed_at: new Date().toISOString() },
    ], dayRows(0, 7, 100), [
      { sender_id: "s1", sender_name: "Kori Katz" },
      { sender_id: "s2", sender_name: "Dan Shapiro" },
    ]),
    WORKSPACE,
  );
  assert.equal(signals.runway.senders, 4);
  // A paused campaign's list is not runway. Counting its 5,000 pending leads would say the client is fine
  // for weeks while nothing at all is going out.
  assert.equal(signals.runway.pending, 600);
  assert.equal(signals.runway.daysLeft, 6);
  assert.equal(signals.runway.needsCampaigns, false);

  const text = signalsAsText(signals);
  // Named where the daily figures have seen the account, counted where they have not. This used to print the
  // bare id, on the reasoning that an id is still enough to go and look it up — but the model does not look
  // anything up, it writes a brief, and what it actually did with a number it could not read was substitute a
  // name from Slack. The count is the honest version and the arithmetic below is unaffected by it.
  assert.match(text, /It has 4 senders assigned\. Names are recorded for only 2 of them: Kori Katz, Dan Shapiro\./);
  assert.match(text, /Total days of sending left across all active campaigns: 6\./);
  // Days left is not stated for a campaign that is not running, or the brief counts a paused list as work.
  assert.doesNotMatch(text, /"BV009".*Days of sending left/);
});

test("under two days of sending, the brief is told to get campaigns built", async () => {
  // The proactive rule, and the reason the runway is computed at all. Building a campaign takes longer
  // than a day, so the alarm has to sound while there is still a day of sending to build against.
  const signals = await gatherSignals(
    readerFor([
      { name: "BV013", status: "IN_PROGRESS", connections_sent: 900, connections_accepted: 200, replies: 20, leads_pending: 40, sender_ids: ["s1", "s2"], refreshed_at: new Date().toISOString() },
    ], dayRows(0, 7, 50), [{ sender_id: "s1", sender_name: "Kori Katz" }]),
    WORKSPACE,
  );
  assert.equal(signals.runway.daysLeft, 1);
  assert.equal(signals.runway.needsCampaigns, true);
  assert.match(signalsAsText(signals), /new campaigns need building now/);
});

test("no campaign running at all is the loudest version of the same finding", async () => {
  const signals = await gatherSignals(
    readerFor([
      { name: "BV010", status: "FINISHED", connections_sent: 900, connections_accepted: 200, replies: 20, leads_pending: 0, sender_ids: ["s1"], refreshed_at: new Date().toISOString() },
    ], dayRows(0, 7, 0)),
    WORKSPACE,
  );
  assert.equal(signals.campaigns.active, 0);
  assert.equal(signals.runway.needsCampaigns, true);
  const text = signalsAsText(signals);
  assert.match(text, /No campaign is running for this client right now/);
  assert.match(text, /new campaigns need building now/);
});

test("a client with no campaign records is not told to build anything", async () => {
  // The figures being absent is not the same as the runway being short, and "start building campaigns" on
  // the strength of a sync that has never run is the kind of wrong instruction that gets a brief muted.
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100)), WORKSPACE);
  assert.equal(signals.runway.needsCampaigns, false);
  assert.doesNotMatch(signalsAsText(signals), /new campaigns need building/);
});

test("an active campaign is listed before a bigger finished one", async () => {
  // Volume was the wrong order. A campaign switched on yesterday has sent almost nothing and is the one
  // the team needs to hear about; the finished campaign with 4,000 sends changes nothing anybody does.
  const signals = await gatherSignals(
    readerFor([
      { name: "BV001", status: "FINISHED", connections_sent: 4_000, connections_accepted: 800, replies: 90, leads_pending: 0, sender_ids: ["s1"], refreshed_at: new Date().toISOString() },
      { name: "BV014", status: "IN_PROGRESS", connections_sent: 12, connections_accepted: 1, replies: 0, leads_pending: 300, sender_ids: ["s1", "s2"], refreshed_at: new Date().toISOString() },
    ], dayRows(0, 7, 50)),
    WORKSPACE,
  );
  assert.equal(signals.campaigns.names[0].name, "BV014");
  assert.equal(signals.campaigns.names[0].isActive, true);
  assert.equal(signals.campaigns.names[0].daysLeft, 6);
});

test("an active campaign with no leads left says it is done sending", async () => {
  // HeyReach keeps a campaign IN_PROGRESS while the leads already in it finish their steps, so a campaign
  // with nothing pending reports itself as running for weeks after it stopped doing new work.
  const signals = await gatherSignals(
    readerFor([
      { name: "BV015", status: "IN_PROGRESS", connections_sent: 500, connections_accepted: 100, replies: 9, leads_pending: 0, sender_ids: ["s1", "s2"], refreshed_at: new Date().toISOString() },
    ], dayRows(0, 7, 10)),
    WORKSPACE,
  );
  assert.equal(signals.campaigns.names[0].daysLeft, 0);
  assert.match(signalsAsText(signals), /no leads left to contact, so it is finished in practice/);
  // Counted in the runway arithmetic, but kept off the brief: "its implied those campaigns are finished".
  assert.match(signalsAsText(signals), /Leave it out of the campaign list entirely/);
});

test("a campaign with no senders reports an unknown runway rather than a finished one", async () => {
  // Zero senders is not "finishing today", it is "not sending at all", and the two want opposite actions.
  const signals = await gatherSignals(
    readerFor([
      { name: "BV016", status: "IN_PROGRESS", connections_sent: 0, connections_accepted: 0, replies: 0, leads_pending: 500, sender_ids: [], refreshed_at: new Date().toISOString() },
    ], dayRows(0, 7, 0)),
    WORKSPACE,
  );
  assert.equal(signals.campaigns.names[0].daysLeft, null);
  assert.equal(signals.runway.daysLeft, null);
  assert.equal(signals.runway.needsCampaigns, true);
  const text = signalsAsText(signals);
  assert.match(text, /No senders are assigned to it/);
  assert.match(text, /Total days of sending left cannot be worked out/);
});

test("an assigned sender whose name we do not know is a count, never an id and never a guess", async () => {
  /*
   * The worst thing this brief has done. Willow's per-sender rows were missing, so the campaign's three
   * account ids resolved to nothing and the figures read "Senders on it: 187697, 117558, 117559". Told to
   * write first names only, the model took three names out of the Slack channel instead, and the brief
   * announced that two colleagues were sending on a client campaign they have no account on. The ids
   * belonged to Roi, Eyal and Shalev.
   *
   * So a name that is not known must arrive as an absence rather than as a number. A number looks like data
   * and invites translation; an absence can be stated.
   */
  const signals = await gatherSignals(
    readerFor([
      { name: "W038: BH 2026 Attendees (Post event)", status: "IN_PROGRESS", connections_sent: 129, connections_accepted: 8, replies: 0, leads_pending: 175, sender_ids: ["187697", "117558", "117559"], refreshed_at: new Date().toISOString() },
    ], dayRows(0, 7, 50)),
    WORKSPACE,
  );
  const campaign = signals.campaigns.names[0];
  assert.deepEqual(campaign.senders, []);
  // The count survives even though no name did, because the runway is computed from it.
  assert.equal(campaign.senderCount, 3);
  assert.equal(campaign.daysLeft, 3);

  const text = signalsAsText(signals);
  assert.match(text, /3 senders assigned, but their names are not recorded/);
  assert.match(text, /Write the count and no names/);
  // The instruction has to name where the wrong names came from, or it is just "do not guess", which lost.
  assert.match(text, /never take one from the Slack channels/);
  for (const id of ["187697", "117558", "117559"]) assert.ok(!text.includes(id), `the figures still leak the id ${id}`);
});

test("a partly named roster names the ones it knows and counts the rest", async () => {
  // The half case is real: one account is new and has not appeared in a daily row yet. Naming two of three
  // is honest, and silently reporting "2 senders" would understate the runway the campaign actually has.
  const signals = await gatherSignals(
    readerFor(
      [{ name: "BV007: ASCs v2", status: "IN_PROGRESS", connections_sent: 100, connections_accepted: 10, replies: 1, leads_pending: 150, sender_ids: ["203189", "218130", "999999"], refreshed_at: new Date().toISOString() }],
      dayRows(0, 7, 50),
      [{ sender_id: "203189", sender_name: "Ali Mahomed" }, { sender_id: "218130", sender_name: "Vijay Prasad MD, MPH" }],
    ),
    WORKSPACE,
  );
  const campaign = signals.campaigns.names[0];
  assert.deepEqual(campaign.senders, ["Ali Mahomed", "Vijay Prasad MD, MPH"]);
  assert.equal(campaign.senderCount, 3);
  const text = signalsAsText(signals);
  assert.match(text, /It has 3 senders assigned\. Names are recorded for only 2 of them: Ali Mahomed, Vijay Prasad MD, MPH\./);
  assert.ok(!text.includes("999999"), "the unresolved id leaked into the figures");
});

test("the figures reach the model as prose, and are labelled as facts", async () => {
  const signals = await gatherSignals(readerFor([], [...dayRows(0, 7, 100), ...dayRows(7, 7, 50)]), WORKSPACE);
  const content = briefUserContent(WORKSPACE, {
    signals,
    internal: { channelId: "C1", messages: 12, text: "10:00 Kiril: launching Willow campaign 3 today" },
    external: { channelId: "C2", messages: 0, text: "" },
  });
  assert.match(content, /Do not restate them differently and do not compute new ones/);
  assert.match(content, /700/);
  assert.match(content, /launching Willow campaign 3 today/);
  // A channel with nothing in it is a finding, not an omission: a client channel that went silent for
  // a week is one of the four things the brief exists to notice.
  assert.match(content, /Nothing has been said in this channel/);
});

test("a channel that could not be read becomes a line in the brief", () => {
  const content = briefUserContent(WORKSPACE, {
    signals: { campaigns: { total: 0, active: 0, paused: 0, finished: 0, names: [] }, runway: { daysLeft: null, pending: 0, senders: 0, needsCampaigns: false }, sending: { thisWeek: 0, lastWeek: 0, changePercent: null, lastDayWithSends: null, quietDays: 0 }, replies: { thisWeek: 0, lastWeek: 0 }, acceptance: { thisWeek: null, lastWeek: null }, staleness: { statsAgeHours: null, dayCount: 0 }, source: { live: true, reason: "" } },
    internal: { channelId: "C1", messages: 0, text: "", error: "The Reply Radar bot is not in that channel. Invite it, then try again." },
    external: { channelId: "", messages: 0, text: "" },
  });
  assert.match(content, /bot is not in that channel/);
  assert.match(content, /Say so in one line/);
});

test("the model is given the call transcript and nothing else about the call", async () => {
  // Granola writes its own summary of every call, and it used to be sent above the transcript. It made the
  // brief worse: a summary sitting over a transcript gets read as the answer, so the brief paraphrased
  // Granola's conclusions instead of finding the sentence where somebody said they would do something.
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100)), WORKSPACE);
  const content = briefUserContent(WORKSPACE, {
    signals,
    internal: { channelId: "C1", messages: 4, text: "10:00 Kiril: hi" },
    external: { channelId: "", messages: 0, text: "" },
    call: { title: "QC <> Bluevia Weekly", ageDays: 2, owner: "Kiril", transcript: "Kori: I'll have the enriched list by Thursday.", truncated: false },
  });
  assert.match(content, /I'll have the enriched list by Thursday/);
  assert.match(content, /Transcript, in full/);
  assert.doesNotMatch(content, /Granola's own summary/);
  assert.doesNotMatch(content, /only the summary above is available/);
});

test("thread replies are explained to the model, not just handed to it", async () => {
  // The commitment is usually the fourth reply down, and a model told nothing about the indentation reads
  // a thread as a run of unrelated remarks — which is the difference between "Kori asked whether the list
  // was ready" and "Kori asked, and Dan said he would have it by Friday".
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100)), WORKSPACE);
  const content = briefUserContent(WORKSPACE, {
    signals,
    internal: { channelId: "C1", messages: 34, raw: 12, threads: 5, replies: 22, text: "10:00 Kiril: list?\n    ↳ 10:04 Dan: Friday" },
    external: { channelId: "", messages: 0, text: "" },
  });
  assert.match(content, /including 22 replies across 5 threads/);
  assert.match(content, /Indented lines beginning ↳ are replies/);
  // A fortnight, not a week: an item agreed nine days ago and not done is the most overdue thing on the
  // account, and a seven-day window is exactly the window in which it disappears.
  assert.match(content, /last 14 days/);
});

test("the recency rule is code-built, so a stored prompt override cannot drop it", async () => {
  // The whole reason it lives in `briefUserContent` and not only in the editable system prompt: a client
  // with a saved override would otherwise never see it, and reconciling stale sources is the correctness
  // fix, not a style preference. The Dan-already-sent-it bug is exactly a stale call outranking a fresh
  // channel message, which this block forbids.
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100)), WORKSPACE);
  const content = briefUserContent(WORKSPACE, {
    signals,
    internal: { channelId: "C1", messages: 4, text: "10:00 Kiril: hi" },
    external: { channelId: "", messages: 0, text: "" },
  });
  assert.match(content, /How to weigh what you are given/);
  assert.match(content, /the newer one wins/);
});

test("the prior briefs and their replies are handed over, with the resolution rule", async () => {
  // The feature: today's brief reads its last brief and the thread replies to it. A reply that closes an
  // item must close it, and the section itself must never leak into what the model writes.
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100)), WORKSPACE);
  const content = briefUserContent(WORKSPACE, {
    signals,
    internal: { channelId: "C1", messages: 4, text: "10:00 Kiril: hi" },
    external: { channelId: "", messages: 0, text: "" },
    priorBriefs: [
      {
        postedOn: "Monday, August 17",
        ageDays: 2,
        body: "1. <@U1> to send Dan the account list",
        replies: [{ who: "Kiril", text: "checked with Ali about cold calling. dead end. resolved" }],
      },
    ],
  });
  assert.match(content, /Your last brief, and how the team replied/);
  assert.match(content, /Monday, August 17 \(2 days ago\)/);
  assert.match(content, /send Dan the account list/);
  assert.match(content, /Kiril: checked with Ali about cold calling\. dead end\. resolved/);
  // The rule that makes a reply authoritative, and the rule that keeps the section invisible.
  assert.match(content, /handled, done, sorted, a dead end or resolved closes that item/);
  assert.match(content, /Never mention this section/);
});

test("a brief with no replies still says so, and pluralises the heading for two", async () => {
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100)), WORKSPACE);
  const content = briefUserContent(WORKSPACE, {
    signals,
    internal: { channelId: "C1", messages: 4, text: "10:00 Kiril: hi" },
    external: { channelId: "", messages: 0, text: "" },
    priorBriefs: [
      { postedOn: "Monday, August 17", ageDays: 2, body: "1. thing one", replies: [] },
      { postedOn: "Friday, August 14", ageDays: 5, body: "1. thing two", replies: [{ who: "Dan", text: "on it" }] },
    ],
  });
  assert.match(content, /Your last briefs, and how the team replied/);
  assert.match(content, /No one replied to this brief\./);
  assert.match(content, /Dan: on it/);
});

test("no prior briefs means no prior-briefs section at all", async () => {
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100)), WORKSPACE);
  const content = briefUserContent(WORKSPACE, {
    signals,
    internal: { channelId: "C1", messages: 4, text: "10:00 Kiril: hi" },
    external: { channelId: "", messages: 0, text: "" },
    priorBriefs: [],
  });
  assert.doesNotMatch(content, /how the team replied/);
});

test("a client override is a different key from the global prompt", () => {
  assert.equal(morningBriefPromptKey(), "morning_brief_prompt");
  assert.equal(morningBriefPromptKey("willow"), "morning_brief_prompt_willow");
  assert.equal(morningBriefPromptKey(null), "morning_brief_prompt");
});

test("Slack's own error slug is what gets translated, not the HTTP status", () => {
  // Slack answers 200 with `{ ok: false }`, so a route that trusted the status would report success on
  // every failure there is.
  assert.match(slackLib, /if \(!body\.ok\) throw new Error\(slackErrorText/);
  assert.match(slackLib, /not_in_channel/);
  assert.match(slackLib, /channel_not_found/);
});

test("a brief posts as the bot even when only a user token is set", () => {
  // The user token exists so reads need no channel invitations. Letting a post fall back to it would put
  // a brief into a client-facing channel under a person's name, and the client would reply to them.
  assert.match(slackLib, /const token = actor === "write" \? botToken\(\) : readToken\(\);/);
  // The only calls that ask for the write credential are the five that write: posting a message, editing
  // one (the Slack assistant rewrites its reply in place as the answer forms), deleting one (the assistant
  // leaves the thread with just QC Bot's answer), and adding and removing the :eyes: reaction that marks
  // the bot working. Reads must never reach for the write token, so this count guards against a read
  // quietly acquiring it.
  assert.equal(slackLib.match(/\}, "write"\);/g)?.length, 5);
  assert.match(slackLib, /chat\.postMessage[\s\S]{0,700}\}, "write"\);/);
  assert.match(slackLib, /chat\.update[\s\S]{0,700}\}, "write"\);/);
  assert.match(slackLib, /chat\.delete[\s\S]{0,400}\}, "write"\);/);
  assert.match(slackLib, /reactions\.add[\s\S]{0,400}\}, "write"\);/);
  assert.match(slackLib, /reactions\.remove[\s\S]{0,400}\}, "write"\);/);
});

test("the brief goes in a thread under a header, not flat into the channel", () => {
  /*
   * Three page-long briefs a week posted flat turn the internal channel into a brief archive with the
   * team's real conversations wedged between them. So: a one-line header in the channel, and the brief as
   * a reply in its thread. Order matters — the reply needs the header's `ts`, which only exists once the
   * header has posted, so these two calls can never become a `Promise.all`.
   */
  assert.match(slackLib, /threadTs \? \{ thread_ts: threadTs \} : \{\}/);
  assert.match(route, /messageTs = await postMessage\(channelId, briefHeaderText\(workspace\)\);\s*\n\s*briefTs = await postMessage\(channelId, body_, messageTs\);/);
  // A half-send has to be legible as one. The header standing alone with nothing under it is the visible
  // symptom, and this is the sentence that explains it.
  assert.match(route, /The header posted but the brief did not/);
  // `posted` is the brief arriving, not the header arriving — otherwise a failed reply reports success.
  assert.match(route, /const posted = Boolean\(briefTs\);/);
});

test("the header is a date and a client and nothing else", () => {
  const header = briefHeaderText({ ...WORKSPACE, timezone: "America/New_York" }, new Date("2026-08-17T14:00:00Z"));
  assert.match(header, /Willow Morning Brief \(Monday, August 17th\)/);
  // One line. The whole reason for the split is that the channel gets one glanceable line, so a header that
  // grew a second line explaining itself would have defeated it — Slack already prints the reply count.
  assert.equal(header.split("\n").length, 1);
  assert.doesNotMatch(header, /in this thread/);
  // Two spaces before the emoji. Slack sets an emoji at cap height, so hard against the closing bracket it
  // looked cramped, and a single space is what anybody tidying this would leave behind.
  assert.match(header, /\)\* {2}:coffee:$/);
});

test("the day of the month is written the way it is said", () => {
  const on = (iso) => briefHeaderText(WORKSPACE, new Date(iso));
  assert.match(on("2026-08-01T14:00:00Z"), /August 1st/);
  assert.match(on("2026-08-02T14:00:00Z"), /August 2nd/);
  assert.match(on("2026-08-03T14:00:00Z"), /August 3rd/);
  assert.match(on("2026-08-04T14:00:00Z"), /August 4th/);
  // The teens are the whole reason this is not `day + suffix[day % 10]`: 11th, 12th and 13th, not 11st.
  assert.match(on("2026-08-11T14:00:00Z"), /August 11th/);
  assert.match(on("2026-08-12T14:00:00Z"), /August 12th/);
  assert.match(on("2026-08-13T14:00:00Z"), /August 13th/);
  assert.match(on("2026-08-21T14:00:00Z"), /August 21st/);
  assert.match(on("2026-08-22T14:00:00Z"), /August 22nd/);
});

test("Monday and Friday carry a standing reminder, midweek carries none", async () => {
  /*
   * Two rituals bracket the week: agreeing the plan on Monday, sending the client their report on Friday.
   * Neither will ever turn up as an action item, because nobody posts "remember the weekly report" in Slack
   * and nobody says it on a call. It is just what happens every week, which is exactly why it gets
   * forgotten, so it is a fixed line rather than something the model could be expected to find.
   */
  const zone = "America/New_York";
  const monday = new Date("2026-08-17T14:00:00Z");
  const friday = new Date("2026-08-21T14:00:00Z");
  assert.equal(briefWeekdayNote(zone, monday), ":speech_balloon: Make sure to sync about game plan for this week! :speech_balloon:");
  assert.equal(briefWeekdayNote(zone, friday), ":page_facing_up: Remember to send out the EOW report! :page_facing_up:");
  // Midweek gets nothing. A reminder that appears every day is wallpaper.
  assert.equal(briefWeekdayNote(zone, new Date("2026-08-19T14:00:00Z")), "");
  assert.equal(briefWeekdayNote(zone, new Date("2026-08-20T14:00:00Z")), "");

  // The model is told the reminder exists and told not to write it, because it is appended afterwards. Told
  // only the second half, it would have no idea why the posted brief carries a line it did not write.
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100)), WORKSPACE);
  const content = briefUserContent(WORKSPACE, { signals, internal: { channelId: "", messages: 0, text: "" }, external: { channelId: "", messages: 0, text: "" } });
  assert.match(content, /(added to the foot of the brief automatically|There is no standing reminder for today)/);
});

test("the standing reminder is appended under the brief, indented, fenced by dividers", () => {
  /*
   * Position, wording and indent are all fixed, and the model got each of them wrong at least once while
   * this brief was being tuned. So it is concatenated rather than generated: there is nothing for a model to
   * add to a constant except variation, and a standing reminder is the one line that must not vary.
   *
   * The indent is how it reads as centred. Slack has no centre alignment, so leading spaces are the only
   * lever, and leading spaces are exactly what a model tidies away.
   */
  const zone = "America/New_York";
  const friday = new Date("2026-08-21T14:00:00Z");
  const body = "*:hourglass: _Client Bottlenecks_ :hourglass:*\n\n1. *Cold calling update*";

  const posted = briefWithFooter(body, zone, friday);
  assert.ok(posted.includes("1. *Cold calling update*"), "the model's own findings must come through untouched");
  assert.match(posted, /\n\n\n={37}\n\n {3}:page_facing_up: Remember to send out the EOW report! :page_facing_up:\n\n={37}$/);
  // Under the findings, never above them: it is a closing ritual, not the headline.
  assert.ok(posted.indexOf("Cold calling") < posted.indexOf("EOW report"));

  // Monday's is the same shape with its own emoji, so the two cannot drift apart. Its own indent, though:
  // the line is wider than the rule, so any indent at all would wrap it, and a wrapped line is not centred.
  assert.match(briefWithFooter(body, zone, new Date("2026-08-17T14:00:00Z")), /\n:speech_balloon: Make sure to sync about game plan for this week! :speech_balloon:\n/);

  // Midweek the brief ends on the last finding, with no empty fence hanging off the end of it.
  const midweek = briefWithFooter(body, zone, new Date("2026-08-19T14:00:00Z"));
  assert.ok(midweek.endsWith("1. *Cold calling update*"), midweek);
  assert.ok(!midweek.includes("EOW report") && !midweek.includes("game plan"), "a day with no reminder must not get one");
});

test("the brief the model writes is not asked to carry the reminder as well", () => {
  // Both halves have to agree or today's brief says it twice: the prompt forbids writing it, the code adds it.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /Do not write the day's standing reminder yourself/);
  assert.ok(!DEFAULT_MORNING_BRIEF_PROMPT.includes("Make sure to sync about game plan"), "the worked example still models the reminder the model must not write");
});

test("every section heading is fenced above and below and centred, and the model draws none of it", () => {
  /*
   * The fencing is applied to the model's output rather than asked for, for the same reason the reminder is.
   * Asked for it, runs came back with the rule above the heading but not below, or centred by a different
   * number of spaces each time, and leading whitespace is the first thing a model tidies away.
   */
  const divider = "=".repeat(37);
  const body = [
    "*:signal_strength: _Active Campaigns_ :signal_strength:*",
    "",
    "",
    "1. *BV007: ASCs v2*",
    "    • 106 pending leads (~2 days of sending left)",
    "",
    divider,
    "",
    "*:male-technologist: _Things to work on_ :male-technologist:*",
    "",
    "",
    "1. <@U01> to *finish the Doximity list*",
  ].join("\n");

  const framed = briefFraming(body);

  // It opens on a rule, not on the heading and not on a title.
  assert.ok(framed.startsWith(`${divider}\n\n${" ".repeat(20)}*:signal_strength:`), framed.slice(0, 140));
  for (const heading of ["*:signal_strength: _Active Campaigns_ :signal_strength:*", "*:male-technologist: _Things to work on_ :male-technologist:*"]) {
    assert.ok(framed.includes(`${divider}\n\n${" ".repeat(20)}${heading}\n\n${divider}`), `${heading} was not fenced and centred`);
  }
  // Four rules for two sections. The model's own leftover divider was dropped rather than left in a gap.
  assert.equal(framed.split(divider).length - 1, 4);
  // Two blank lines between the end of one section and the rule that opens the next.
  assert.match(framed, /pending leads \(~2 days of sending left\)\n\n\n={37}/);
  // The sub-bullet's own indent is the model's and means something, so it survives untouched.
  assert.ok(framed.includes("    • 106 pending leads"));
});

test("the indent is worked out per line, so a short heading and a long reminder both land centred", () => {
  /*
   * Emoji render about five spaces wide, so a heading cannot be centred by counting characters, and one
   * fixed indent cannot serve both a two word heading and a reminder that nearly fills the rule. The first
   * attempt used a single constant and came out looking left aligned, which is what Kiril reported.
   *
   * The numbers are approximate by nature, since Slack's font is proportional. What is asserted is that they
   * are derived: the shorter line is pushed further in, and nothing is pushed past the end of the rule.
   */
  const indentOf = (heading) => briefFraming(`${heading}\n\n1. x`).split("\n")[2].match(/^ */)[0].length;

  // The two long headings agree, so the three sections do not each sit somewhere different.
  assert.equal(indentOf("*:signal_strength: _Active Campaigns_ :signal_strength:*"), 20);
  assert.equal(indentOf("*:male-technologist: _Things to work on_ :male-technologist:*"), 20);
  // A shorter heading is pushed further in rather than lining up with the others on the left.
  assert.ok(indentOf("*:hourglass: _Client Bottlenecks_ :hourglass:*") < 20);
  // A line wider than the rule gets no indent at all, because indenting it would wrap it.
  assert.equal(indentOf("*:hourglass: _A heading far too long to be centred under any rule this width_ :hourglass:*"), 0);
});

test("each sub-bullet under an item is stepped in further than the one above it", () => {
  /*
   * Kiril's rule, and it earns its place: the second bullet is almost always the accountability clause,
   * which is a comment on the first bullet rather than a sibling of it. Two bullets at the same indent read
   * as one block of text.
   *
   * Normalised in code because the model has to get this right several times per brief rather than once, and
   * because leading whitespace is the first thing it tidies away.
   */
  const framed = briefFraming([
    "*:male-technologist: _Things to work on_ :male-technologist:*",
    "",
    "1. <@U01> to *finish the Doximity list*",
    "• scoring and filtering to the top ~2,000 contacts",
    "    • _agreed on the Aug 5 call, no update since._",
    "",
    "2. <@U02> to *send campaign updates*",
    "        • _said on Aug 12 that updates were coming, nothing has gone out._",
  ].join("\n"));

  assert.ok(framed.includes("\n    • scoring and filtering to the top ~2,000 contacts\n"), framed);
  assert.ok(framed.includes("\n        • _agreed on the Aug 5 call, no update since._\n"), framed);
  // The counter resets on the next item, so the second item's only bullet starts at four again however the
  // model indented it. Otherwise the steps accumulate down the section and the last item sits off the screen.
  assert.ok(framed.includes("\n    • _said on Aug 12 that updates were coming, nothing has gone out._"), framed);
});

test("the old status title is dropped even when something still writes one", () => {
  // Kiril took the line out: three sections that announce themselves do not need a label above them. A
  // per-client prompt override still carries the old instruction, so it has to die here too or it comes
  // back on one client only.
  const framed = briefFraming("*Midweek Status:*\n\n\n*:hourglass: _Client Bottlenecks_ :hourglass:*\n\n1. *Cold calling*");
  assert.ok(!framed.includes("Midweek Status"), framed);
  assert.ok(framed.startsWith("=".repeat(37)));
  assert.ok(framed.includes("1. *Cold calling*"));
});

test("a heading written without its asterisks is still fenced, and normalised on the way", () => {
  // Three headings formatted three ways is the kind of thing nobody reports and everybody notices.
  const framed = briefFraming(":hourglass: _Client Bottlenecks_ :hourglass:\n\n1. *Cold calling*");
  assert.ok(framed.includes(`${"=".repeat(37)}\n\n${" ".repeat(18)}*:hourglass: _Client Bottlenecks_ :hourglass:*\n\n${"=".repeat(37)}`), framed);
});

test("the runway warning is not mistaken for a section heading", () => {
  /*
   * The warning is an emoji, some words, and the same emoji again, which is the shape of a heading. Matched
   * loosely it was fenced into a section of its own with nothing under it, putting the most urgent line in
   * the brief where it read as a decoration. The italics on a real heading are what separate the two.
   */
  const warning = ":warning: New leads or a new campaign must be in motion today! Less than 2 days of sending remaining! :warning:";
  const framed = briefFraming([
    "*:signal_strength: _Active Campaigns_ :signal_strength:*",
    "",
    "1. *BV007: ASCs v2*",
    "",
    warning,
  ].join("\n"));

  // One section, so exactly two rules, and the warning is inside it rather than fenced off on its own.
  assert.equal(framed.split("=".repeat(37)).length - 1, 2);
  assert.ok(framed.trimEnd().endsWith(warning), framed);
});

test("a brief with no headings at all is left alone rather than cut up", () => {
  // Framing something that is not in this shape risks dropping findings. An unframed brief is a cosmetic
  // failure; a truncated one is a lie about the week.
  const plain = "The internal channel could not be read, so there is nothing to report.";
  assert.equal(briefFraming(plain), plain);
});

test("the prompt hands the fencing to the code and asks for neither dividers nor a title", () => {
  // Both halves have to agree. If the prompt still asked for either, the code would strip work the model
  // spent words on, and the brief would come out a section short of what it wrote.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /\*\*Start with the first section heading\.\*\*/);
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /\*\*No divider lines anywhere\.\*\*/);
  assert.ok(!DEFAULT_MORNING_BRIEF_PROMPT.includes("========"), "the prompt still draws a divider the model would copy");
  const example = DEFAULT_MORNING_BRIEF_PROMPT.slice(DEFAULT_MORNING_BRIEF_PROMPT.indexOf("A worked example"));
  assert.ok(!/Status:/.test(example), "the worked example still opens on a status title");
});

test("the model is handed the mention code for everybody who spoke", async () => {
  /*
   * An owner named in plain text is an owner who never finds out. `<@U04AB12CD>` is the only form Slack
   * notifies on and it cannot be derived from a display name, so the mapping is handed over as a table.
   * Built from the people in the transcripts, which is also the rail: the brief cannot ping a stranger.
   */
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100)), WORKSPACE);
  const content = briefUserContent(WORKSPACE, {
    signals,
    internal: { channelId: "C1", messages: 2, text: "10:00 Kori: list?", people: [{ id: "U01", name: "Kori" }] },
    external: { channelId: "C2", messages: 1, text: "11:00 Jake: ok", people: [{ id: "U02", name: "Jake" }, { id: "U01", name: "Kori" }] },
  });
  assert.match(content, /Kori → <@U01>/);
  assert.match(content, /Jake → <@U02>/);
  // Once, not twice: Kori spoke in both channels and a duplicated row invites the model to pick one at random.
  assert.equal(content.match(/<@U01>/g)?.length, 1);
});

test("no mention table is offered when nobody could be identified", async () => {
  // An empty table is an invitation to invent a mention code, and a made-up id renders as dead text.
  const signals = await gatherSignals(readerFor([], dayRows(0, 7, 100)), WORKSPACE);
  const content = briefUserContent(WORKSPACE, {
    signals,
    internal: { channelId: "C1", messages: 1, text: "10:00 U01: hi", people: [] },
    external: { channelId: "", messages: 0, text: "" },
  });
  assert.doesNotMatch(content, /How to mention people/);
});

test("an action item is checked against the figures before it is printed", () => {
  /*
   * The failure this exists for: Kori asked for two senders to be added to a campaign, it was done the
   * same morning, and the next brief asked whether it had been done. Re-raising handled work is how a
   * brief loses the reader — and once they stop reading, the real items go with it.
   *
   * The check has to be against HeyReach rather than against the channel, because the channel is where
   * somebody says they did something. The figures are where it either happened or did not.
   */
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /check whether it is already done/i);
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /the system of record/);
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /Done: leave it out entirely/);
  // And the disagreement is a finding, not a tie to be broken quietly in the figures' favour.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /The channel says done and the Figures say otherwise/);
  // Once, though. The first live run of this printed the same contradiction three times over — at the top,
  // as an owned item, and again as a parenthetical on the campaign — which is exactly the wall of text the
  // brief exists to avoid.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /\*\*Once, though\.\*\*/);
});

test("the brief is told to mention people and to name campaigns in full", () => {
  // Two reversals of the old prompt, which forbade mentions outright and let a campaign be called by its
  // prefix. "BV007" does not tell the reader which campaign it is, so the item cannot be acted on.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /Mention people with their mention code/);
  assert.doesNotMatch(DEFAULT_MORNING_BRIEF_PROMPT, /the brief must not ping anybody/);
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /Campaign names in full/);
  // Slack's API supports bold, italic, strike and code, and no underline. Asked for one anyway, the model
  // reaches for markdown or HTML that renders as literal characters in the middle of the heading.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /\*\*There is no underline in Slack\*\*/);
});

test("the brief has three sections, and the owner's mention starts the line", () => {
  /*
   * The rewrite that came out of comparing a real run against a hand-written one. The differences were not
   * cosmetic: the hand-written version was a third the length, listed only active campaigns, gave senders
   * as first names, and — the big one — put the owner's mention at the *start* of every action item, so a
   * person scanning for their own name finds it without reading a sentence first.
   */
  for (const heading of [":signal_strength: _Active Campaigns_ :signal_strength:", ":male-technologist: _Things to work on_ :male-technologist:", ":hourglass: _Client Bottlenecks_ :hourglass:"]) {
    assert.match(DEFAULT_MORNING_BRIEF_PROMPT, new RegExp(heading));
  }
  // The two the first version guessed at. Kiril picked these, and an emoji name Slack does not know renders
  // as literal `:bar_chart:` text in the middle of the heading.
  assert.doesNotMatch(DEFAULT_MORNING_BRIEF_PROMPT, /:bar_chart:|:construction_worker:/);
  // Sections the hand-written version did without. An urgent section is a second place to say the same
  // thing, and the runway warning already lives on the campaign it is about.
  assert.doesNotMatch(DEFAULT_MORNING_BRIEF_PROMPT, /Start here/);
  assert.doesNotMatch(DEFAULT_MORNING_BRIEF_PROMPT, /Worth knowing/);

  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /the owner's mention is the first thing on the line/i);
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /1\. <@OWNER> to \*do the specific thing\*/);
  // Numbered with a blank line between, and indented sub-bullets: the things that turn a wall of text into
  // something readable standing up. The rules that fence each heading are no longer among them, because
  // they are added to the model's output afterwards rather than asked for.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /\*\*each one is indented further than the one above it\*\*/);

  // Length is the whole complaint, so it is stated as a number rather than as "be concise".
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /150 to 250 words/);
  // Only what is running, and senders by first name — full names with credentials repeated on every
  // campaign were a line and a half of text that told the team nothing they did not know. "Active" alone
  // is not enough: a campaign can be active and have nothing left to send, which is finished in practice.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /Only campaigns that are \*both\* active \*and\* still have leads to contact/);
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /A campaign with 0 pending leads is finished/);
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /\*\*First names only\.\*\*/);
  // The redundancy that survived the first pass at this: a detail bullet that paraphrased the italic
  // accountability clause under it, which is the same wall of text at half the width.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /\*\*The other sub-bullet must not restate it\.\*\*/);
  // Two senders whose first names match printed as "Shane, Kiril, Kiril", which reads as a bug rather than
  // as two people. First names are still right; a collision just takes a last initial.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /Never print the same first name twice in one list/);
});

test("nothing the model is given contains an em dash", () => {
  /*
   * The brief is told never to write one, because an em dash is the clearest tell that a machine wrote the
   * message. A prompt that demands that while modelling the opposite loses to the example every time, so
   * the ban has to hold across everything the model actually reads: the prompt, the figures, the mention
   * table, the call framing. Code comments are exempt, since the model never sees them.
   */
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /\*\*Never use an em dash or an en dash\.\*\*/);

  const dashes = /[—–]/;
  // The one legitimate occurrence is the rule itself naming the characters it forbids.
  const withoutTheRule = DEFAULT_MORNING_BRIEF_PROMPT.split("\n").filter((line) => !/Never use an em dash/.test(line));
  for (const line of withoutTheRule) assert.doesNotMatch(line, dashes, `the prompt models an em dash: ${line.slice(0, 90)}`);
});

test("the figures the model is handed contain no em dash either", async () => {
  const signals = await gatherSignals(readerFor(
    [{ name: "W1", status: "IN_PROGRESS", connections_sent: 100, connections_accepted: 20, replies: 4, leads_pending: 0, sender_ids: ["1"] }],
    // A fortnight of nothing, which is the branch that used to print "since Jan 10 — that is 14 days quiet".
    dayRows(0, 3, 0).concat(dayRows(3, 11, 40)),
  ), WORKSPACE);
  assert.doesNotMatch(signalsAsText(signals), /[—–]/);
});

test("reading prefers a teammate's token, and says so when neither is set", () => {
  // A bot can only read a channel it was invited to, and the external channels are shared with the
  // client, where adding an app is not our decision to make.
  assert.match(slackLib, /export function readToken\(\)[\s\S]{0,80}return userToken\(\) \|\| botToken\(\);/);
  assert.match(slackLib, /Neither \$\{SLACK_USER_TOKEN_ENV\} nor \$\{SLACK_TOKEN_ENV\}/);
});

test("a reply is nested under what it answers, and does not open a day", () => {
  // Flattened into the day, "Kori asked whether the list was ready" and "Dan said Friday" read as two
  // unrelated remarks, and the brief loses the only thing that made them an answer. A reply also carries
  // the date of the thread it is in, so letting one open a "## Thu" heading would date the parent wrongly.
  const at = (iso) => new Date(iso);
  const lines = transcript([
    { ts: "1", at: at("2026-08-13T14:00:00Z"), author: "U1", text: "list ready?", replies: 2 },
    { ts: "2", at: at("2026-08-14T09:00:00Z"), author: "U2", text: "Friday", replies: 0, isReply: true },
    { ts: "3", at: at("2026-08-14T09:05:00Z"), author: "U1", text: "thanks", replies: 0, isReply: true },
    { ts: "4", at: at("2026-08-14T15:00:00Z"), author: "U2", text: "launched BV014", replies: 0 },
  ], new Map([["U1", "Kori Katz"], ["U2", "Dan Shapiro"]]), "America/New_York");

  assert.match(lines, /Kori Katz: list ready\? \[thread, 2 replies\]/);
  assert.match(lines, /^ {4}↳ .*Dan Shapiro: Friday$/m);
  // Two headings, not three: the two replies sit under Thursday's message even though their own timestamps
  // are Friday, and only the channel's own message opens Friday.
  assert.equal(lines.match(/^## /gm).length, 2);
});

test("every thread is opened, and the parent is not printed twice", () => {
  // `conversations.history` returns the message that started a thread and none of its replies, so the
  // previous version of this counted threads it never read. The commitment is almost always in the
  // replies — the parent is "here's the list, what do you think" and the fourth reply down is "I'll have
  // it Friday" — so a brief built from parents alone reads a channel of decisions as a channel of links.
  assert.match(slackLib, /conversations\.replies\?/);
  // Slack includes the parent as the first element of its own thread, and keeping it would print every
  // threaded message twice.
  assert.match(slackLib, /String\(message\.ts \?\? ""\) !== String\(head\.ts \?\? ""\)/);
  // Only threads whose parent survived filtering: a thread hanging off a join notice is not a conversation.
  assert.match(slackLib, /const heads = parents\.filter\(\(message\) => Number\(message\.reply_count \?\? 0\) > 0\);/);
  // A few at a time, not fifty at once. `conversations.replies` is rate limited per minute and a 429 here
  // would cost the sixty-second brief more time than the throttle does.
  assert.match(slackLib, /const THREAD_CONCURRENCY = 8;/);
});

test("one unreadable thread does not cost the channel", () => {
  // The parent still carries its reply count, so the transcript says a conversation happened even where
  // its contents could not be read. Throwing would lose the fortnight over one message.
  assert.match(slackLib, /\} catch \{[\s\S]{0,220}return \[\] as RawMessage\[\];/);
});

test("channel joins and leaves are not activity", () => {
  // A quiet channel that somebody joined is still a quiet channel, and a brief that counted the join
  // would report a week of movement on a dead account.
  assert.match(slackLib, /subtype[\s\S]{0,60}startsWith\("channel_"\)/);
});

test("briefs are kept beyond the sync-run sweep, and every attempt is recorded", () => {
  // "This has slipped three weeks running" is the whole point of a recurring brief, and `rr_sync_runs`
  // is swept at 48 hours.
  assert.match(schema, /create table if not exists rr_slack_briefs/);
  assert.match(schema, /rr_slack_briefs_workspace_created_idx/);
  assert.match(schema, /slack_internal_channel_id text, slack_external_channel_id text/);
  // A failed send answers "did this client get a brief" as firmly as a successful one.
  assert.match(route, /status: sendError \? "error" : "success"/);
});

test("a brief with nowhere to go is refused before the model is called", () => {
  // The refusal has to come first, or a misconfigured client costs a Sonnet call every time somebody
  // presses the button to find out.
  const refuseAt = route.indexOf("has no internal channel id");
  const modelAt = route.indexOf("writeBrief(systemPrompt");
  assert.ok(refuseAt > 0 && modelAt > 0, "both the refusal and the model call are in the route");
  assert.ok(refuseAt < modelAt, "the channel is checked before the model is called");
});

test("the brief route fits inside the Hobby function ceiling", () => {
  assert.match(route, /export const maxDuration = 60;/);
});

// ── The trace ────────────────────────────────────────────────────────
//
// The trace is what somebody reads when a brief came back thin, so the one thing it must never do is
// report a source as working when the brief did not get it. Every test here is about that: the states,
// the counts, and the fact that it is built from the same inputs the model was given rather than from a
// separate set of notes taken as the run went.

const NO_SIGNALS = {
  campaigns: { total: 0, active: 0, paused: 0, finished: 0, names: [] },
  runway: { daysLeft: null, pending: 0, senders: 0, needsCampaigns: false },
  sending: { thisWeek: 0, lastWeek: 0, changePercent: null, lastDayWithSends: null, quietDays: 0 },
  replies: { thisWeek: 0, lastWeek: 0 },
  acceptance: { thisWeek: null, lastWeek: null },
  staleness: { statsAgeHours: null, dayCount: 0 },
  source: { live: true, reason: "" },
};

const OUTCOME = { model: "claude-sonnet-4-6", promptChars: 6_000, contentChars: 48_000, briefChars: 1_400, destination: "preview", channelId: "", posted: false };

/** The step for one system, so a test can assert on it without depending on the order. */
const stepFor = (steps, source) => steps.find((step) => step.source === source);

test("a run that used every source says four of four", () => {
  const steps = briefTrace({ ...WORKSPACE, client_brief: "Willow sells to RevOps leads." }, {
    signals: { ...NO_SIGNALS, campaigns: { total: 2, active: 2, paused: 0, finished: 0, names: [] }, staleness: { statsAgeHours: 2, dayCount: 14 } },
    internal: { channelId: "C1", messages: 18, raw: 23, capped: false, text: "10:00 Kiril: shipping today" },
    external: { channelId: "C2", messages: 5, raw: 5, capped: false, text: "09:00 Client: any update?" },
    call: { title: "QC <> Bluevia Weekly", ageDays: 5, owner: "Kiril", startedAt: Date.parse("2026-08-12T19:00:00Z"), attendees: ["Kiril Ivlev", "Dan Shapiro"], durationMinutes: 33, transcript: "Kiril: we will send the list Thursday.", truncated: false },
    brain: "# What the QC Brain says about Willow\n\nThree campaigns, RevOps persona.",
  }, OUTCOME);

  assert.equal(steps.length, 6);
  assert.deepEqual(steps.map((step) => step.source), ["Slack channels", "Granola", "HeyReach", "Standing context", "Anthropic", "Slack post"]);
  assert.ok(steps.every((step) => step.state === "ok"), `every source was live: ${steps.filter((step) => step.state !== "ok").map((step) => step.source)}`);
  assert.match(stepFor(steps, "Anthropic").result, /Fed 4 of 4 sources to claude-sonnet-4-6/);
});

test("a run stored before the trackers existed gets no tracker step, rather than a failing one", () => {
  // The step is only absent for history. Marking those runs "missing" would report a failure that could
  // not have happened, and a trace full of red for things nobody did is a trace people stop reading.
  const steps = briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "", messages: 0, text: "" },
    external: { channelId: "", messages: 0, text: "" },
  }, OUTCOME);
  assert.equal(stepFor(steps, "Airtable trackers"), undefined);
});

test("a tracker step that wrote rows names the campaigns it closed and explains the deletions", () => {
  const steps = briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "", messages: 0, text: "" },
    external: { channelId: "", messages: 0, text: "" },
  }, {
    ...OUTCOME,
    tracker: {
      attempted: true,
      items: 4,
      result: {
        ran: true,
        campaigns: { created: 1, updated: 3, finished: ["BV007: ASC owners"] },
        projects: { created: 2, updated: 1, removed: 2 },
        notes: [],
      },
    },
  });

  const step = stepFor(steps, "Airtable trackers");
  assert.equal(step.state, "ok");
  assert.match(step.result, /Campaign Tracker: 1 row added, 3 refreshed/);
  assert.match(step.result, /Project Tracker: 2 items added, 1 updated, 2 removed/);
  assert.match(step.facts.join(" "), /BV007: ASC owners has no leads left/);
  // Somebody who opens Airtable to fewer cards than yesterday has to be able to find out why here.
  assert.match(step.facts.join(" "), /Rows nobody's brief created are never touched/);
});

test("a tracker step that was skipped says why, and one that half-worked is a partial", () => {
  const skipped = stepFor(briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "", messages: 0, text: "" },
    external: { channelId: "", messages: 0, text: "" },
  }, { ...OUTCOME, tracker: { attempted: false, reason: "Willow has no Airtable base mapped, so there is no tracker to update." } }), "Airtable trackers");
  assert.equal(skipped.state, "missing");
  assert.match(skipped.result, /no Airtable base mapped/);

  const partial = stepFor(briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "", messages: 0, text: "" },
    external: { channelId: "", messages: 0, text: "" },
  }, {
    ...OUTCOME,
    tracker: {
      attempted: true,
      items: 3,
      result: { ran: true, campaigns: { created: 0, updated: 2, finished: [] }, projects: { created: 3, updated: 0, removed: 0 }, notes: ['This base has no Status option meaning "finished".'] },
    },
  }), "Airtable trackers");
  assert.equal(partial.state, "partial");
  assert.match(partial.facts.join(" "), /no Status option meaning "finished"/);
});

test("the standing context is its own step, so a client nobody has written up is visible", () => {
  /*
   * The failure this is here for: a brief that reports figures and never calls one of them off-plan reads
   * as a thin brief, when what actually happened is that this client has no brief and no brain folder. That
   * is a fixable thing, and it is only fixable if somebody can see it.
   */
  const bare = briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "", messages: 0, text: "" },
    external: { channelId: "", messages: 0, text: "" },
  }, OUTCOME);
  assert.equal(stepFor(bare, "Standing context").state, "missing");
  assert.match(stepFor(bare, "Standing context").facts.join(" "), /No client brief has been written/);
  assert.match(stepFor(bare, "Standing context").facts.join(" "), /Nothing was read out of the QC Brain/);

  // One of the two is a partial, not a pass: half the standing context missing changes what a brief can say.
  const half = briefTrace({ ...WORKSPACE, client_brief: "Willow sells to RevOps leads." }, {
    signals: NO_SIGNALS,
    internal: { channelId: "", messages: 0, text: "" },
    external: { channelId: "", messages: 0, text: "" },
  }, OUTCOME);
  assert.equal(stepFor(half, "Standing context").state, "partial");
  assert.equal(stepFor(half, "Standing context").excerpts.length, 1);
});

test("the extra channels and extra calls are traced as extras, on the steps they came from", () => {
  // Extras share a step with the source they were fetched from, because they were the same act. What must
  // not be shared is the wording: an extra reading as one of the two named channels is the whole risk.
  const steps = briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "C1", messages: 4, raw: 4, text: "10:00 Kiril: shipping today" },
    external: { channelId: "C2", messages: 2, raw: 2, text: "09:00 Client: any update?" },
    extraChannels: [{ channelId: "C9", messages: 11, raw: 11, text: "11:00 Dan: leads are loaded" }],
    call: null,
    callReason: 'No meeting with "Willow" in the title was found in the last 14 days.',
    extraCalls: [{ title: "QC internal, Willow", ageDays: 2, owner: "Kiril", transcript: "Kiril: we will rebuild the list.", truncated: false }],
  }, OUTCOME);

  const slack = stepFor(steps, "Slack channels");
  assert.match(slack.facts.join(" "), /Extra C9: 11 messages and replies, ranked below the two above/);
  assert.equal(slack.excerpts.length, 3);
  /*
   * The client's own call was missing and an internal one was read instead. That is a different brief from
   * one built on the client's own words, and this is the step that has to say so rather than reading as
   * though nothing was found at all.
   */
  const granola = stepFor(steps, "Granola");
  assert.equal(granola.state, "missing");
  assert.match(granola.facts.join(" "), /Also read 1 extra meeting, ranked below the client's own call/);
  assert.equal(granola.excerpts.length, 1);
});

test("a source that came back empty is not allowed to read as working", () => {
  // The failure this is here for: two sources posting a brief that looks exactly like three. The state is
  // what the page colours the step on, so it is the state that has to be wrong-proof, not the wording.
  const steps = briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "C1", messages: 0, raw: 0, capped: false, text: "", error: "QC Bot is not in that channel." },
    external: { channelId: "", messages: 0, raw: 0, capped: false, text: "" },
    call: null,
    callReason: 'No meeting with "Bluevia" in the title was found in the last 14 days.',
  }, OUTCOME);

  assert.equal(stepFor(steps, "Slack channels").state, "missing");
  assert.match(stepFor(steps, "Slack channels").facts.join(" "), /QC Bot is not in that channel/);
  assert.equal(stepFor(steps, "Granola").state, "missing");
  // The reason the matcher gave, verbatim — it is the only thing that says whether to add a teammate's
  // key or type a name into the config page.
  assert.match(stepFor(steps, "Granola").result, /No meeting with "Bluevia" in the title/);
  assert.equal(stepFor(steps, "HeyReach").state, "missing");
  assert.match(stepFor(steps, "Anthropic").result, /Fed 0 of 4 sources/);
});

test("figures that did not come from HeyReach do not read as a working source", () => {
  // The stored copy is the failure that looks like success: every number is present and every one is from
  // Tuesday. A green tick against them is worse than no trace at all, and the reason has to be on the step
  // — "HeyReach timed out" and "no key is saved" send whoever is reading to two different places.
  const stale = {
    ...NO_SIGNALS,
    campaigns: { total: 3, active: 1, paused: 2, finished: 0, names: [] },
    staleness: { statsAgeHours: 70, dayCount: 14 },
    source: { live: false, reason: "HeyReach campaign stats returned 502" },
  };
  const steps = briefTrace(WORKSPACE, { signals: stale, internal: { channelId: "", messages: 0, text: "" }, external: { channelId: "", messages: 0, text: "" } }, OUTCOME);
  assert.equal(stepFor(steps, "HeyReach").state, "partial");
  const facts = stepFor(steps, "HeyReach").facts.join(" ");
  assert.match(facts, /last collected 70 hours ago/);
  assert.match(facts, /HeyReach was not the source of these figures\. HeyReach campaign stats returned 502/);
});

test("a live read says so on the step, and does not report an age", () => {
  // The age of a live figure is zero hours, and printing that invites the reader to wonder which of "zero
  // hours" and "just now" to believe.
  const steps = briefTrace(WORKSPACE, {
    signals: { ...NO_SIGNALS, campaigns: { total: 3, active: 1, paused: 2, finished: 0, names: [] }, staleness: { statsAgeHours: 0, dayCount: 14 } },
    internal: { channelId: "", messages: 0, text: "" },
    external: { channelId: "", messages: 0, text: "" },
  }, OUTCOME);
  const step = stepFor(steps, "HeyReach");
  assert.equal(step.state, "ok");
  assert.match(step.facts[0], /Read from HeyReach during this run/);
  assert.doesNotMatch(step.facts.join(" "), /last collected/);
});

test("every campaign the model was given is listed, and the ones it was not are counted", () => {
  const names = Array.from({ length: 10 }, (_, index) => ({ name: `Campaign ${index + 1}`, status: "ACTIVE", isActive: true, sent: 100, accepted: 25, replies: 4, pending: 50, senders: ["Kori Katz"], senderCount: 1, daysLeft: 2 }));
  const steps = briefTrace(WORKSPACE, {
    signals: { ...NO_SIGNALS, campaigns: { total: 23, active: 10, paused: 13, finished: 0, names }, staleness: { statsAgeHours: 3, dayCount: 21 } },
    internal: { channelId: "", messages: 0, text: "" },
    external: { channelId: "", messages: 0, text: "" },
  }, OUTCOME);
  const facts = stepFor(steps, "HeyReach").facts.join("\n");
  for (const campaign of names) assert.match(facts, new RegExp(`“${campaign.name}”`));
  // A campaign left out of the prompt must be said to have been left out, or the trace reads as the
  // complete picture while the model was working from ten of twenty-three.
  assert.match(facts, /13 smaller campaigns were left out/);
  assert.match(facts, /25%/);
});

test("the trace states the true size of what it is only showing part of", () => {
  // A 60,000-character transcript shown 1,400 characters at a time must not report itself as 1,400, or
  // the next person to wonder whether the whole call was sent will conclude it was not.
  const transcript = "Kiril: ".concat("a".repeat(60_000));
  const steps = briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "", messages: 0, text: "" },
    external: { channelId: "", messages: 0, text: "" },
    call: { title: "QC <> Bluevia Weekly", ageDays: 1, owner: "Kiril", startedAt: Date.parse("2026-08-16T19:00:00Z"), attendees: [], durationMinutes: null, transcript, truncated: true },
  }, OUTCOME);
  const call = stepFor(steps, "Granola");
  const excerpt = call.excerpts.find((piece) => piece.label.startsWith("Transcript"));
  assert.equal(excerpt.chars, transcript.length);
  assert.ok(excerpt.text.length < 2_000, `the excerpt is cut: ${excerpt.text.length}`);
  assert.match(call.facts.join(" "), /only the last part was sent/);
  assert.match(call.facts.join(" "), /The note carried no attendee list/);
});

test("a preview is a finished run, and a refused post is not", () => {
  const inputs = { signals: NO_SIGNALS, internal: { channelId: "", messages: 0, text: "" }, external: { channelId: "", messages: 0, text: "" } };
  const preview = stepFor(briefTrace(WORKSPACE, inputs, OUTCOME), "Slack post");
  assert.equal(preview.state, "ok");
  assert.match(preview.result, /Nothing was posted/);

  const refused = stepFor(briefTrace(WORKSPACE, inputs, { ...OUTCOME, destination: "internal", channelId: "C1", posted: false, sendError: "QC Bot is not in that channel." }), "Slack post");
  assert.equal(refused.state, "missing");
  assert.match(refused.result, /QC Bot is not in that channel/);
});

test("messages Slack sent but the brief dropped are accounted for", () => {
  // A channel full of joins reads as silent, and silence is a finding the brief will act on. The raw
  // count is the only thing that tells the two apart.
  const steps = briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "C1", messages: 2, raw: 40, capped: false, text: "10:00 Kiril: hi" },
    external: { channelId: "", messages: 0, raw: 0, capped: false, text: "" },
  }, OUTCOME);
  const slack = stepFor(steps, "Slack channels");
  assert.equal(slack.state, "partial", "one channel of two is not a complete read");
  assert.match(slack.facts.join(" "), /38 dropped as joins or empty/);
  assert.match(slack.result, /got 40 messages, then opened 0 threads\. 2 messages and replies went to the model/);
});

test("replies read out of threads are counted apart from the channel's own messages", () => {
  // The two numbers deliberately do not reconcile: `raw` is what `conversations.history` returned, and the
  // replies were fetched separately. A trace that subtracted one from the other would report a channel of
  // forty messages and thirty replies as having dropped thirty messages, which is the opposite of true.
  const steps = briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "C1", messages: 70, raw: 44, threads: 9, replies: 30, capped: false, text: "10:00 Kiril: hi" },
    external: { channelId: "", messages: 0, raw: 0, capped: false, text: "" },
  }, OUTCOME);
  const slack = stepFor(steps, "Slack channels");
  assert.match(slack.facts.join(" "), /40 messages over 14 days, 4 dropped as joins or empty/);
  assert.match(slack.facts.join(" "), /opened 9 threads and read 30 replies out of them/);
});

test("the trace is built from what the model was given, not from a second set of notes", () => {
  // The guarantee that makes it worth reading: one object goes to `briefUserContent` and to `briefTrace`,
  // so the trace cannot drift into describing a run that did not happen.
  assert.match(route, /const inputs = \{ signals, \.\.\.channels, call: call\.call, callReason: call\.callReason, extraCalls: call\.extras, brain: brain\.block, priorBriefs \};/);
  assert.match(route, /const content = briefUserContent\(workspace, inputs\);/);
  assert.match(route, /briefTrace\(workspace, inputs, \{/);
  // Not stored. The excerpts quote every client call verbatim, and the row is kept for a year.
  assert.doesNotMatch(route, /signals: \{ \.\.\.signals, sources, steps/);
});

test("the prior-briefs trace step is conditional, so it never disturbs the six fixed steps", () => {
  // With no prior briefs the trace is exactly the six steps the rest of the system depends on. Add one,
  // and a seventh step appears between Slack and Granola, naming the replies that settle old items.
  const base = {
    signals: NO_SIGNALS,
    internal: { channelId: "C1", messages: 4, raw: 4, capped: false, text: "10:00 Kiril: hi" },
    external: { channelId: "", messages: 0, raw: 0, capped: false, text: "" },
  };
  const without = briefTrace(WORKSPACE, base, OUTCOME);
  assert.equal(stepFor(without, "Prior briefs"), undefined);

  const withPriors = briefTrace(WORKSPACE, {
    ...base,
    priorBriefs: [
      { postedOn: "Monday, August 17", ageDays: 2, body: "1. send the list", replies: [{ who: "Kiril", text: "done" }] },
    ],
  }, OUTCOME);
  const step = stepFor(withPriors, "Prior briefs");
  assert.ok(step, "the step is present when prior briefs are");
  assert.equal(step.state, "ok");
  assert.match(step.result, /Read the last brief and 1 reply/);
  assert.match(step.facts.join(" "), /Monday, August 17 \(2 days ago\): 1 reply in the thread/);
  // Ordered right after Slack channels, and it is not counted into the Anthropic "N of 4" source tally.
  assert.equal(withPriors[0].source, "Slack channels");
  assert.equal(withPriors[1].source, "Prior briefs");
});

test("a prior brief nobody answered is a partial step, not a failure", () => {
  const withPriors = briefTrace(WORKSPACE, {
    signals: NO_SIGNALS,
    internal: { channelId: "C1", messages: 4, raw: 4, capped: false, text: "10:00 Kiril: hi" },
    external: { channelId: "", messages: 0, raw: 0, capped: false, text: "" },
    priorBriefs: [{ postedOn: "Monday, August 17", ageDays: 2, body: "1. send the list", replies: [] }],
  }, OUTCOME);
  const step = stepFor(withPriors, "Prior briefs");
  assert.equal(step.state, "partial");
  assert.match(step.result, /found no replies, so nothing has been marked handled since/);
});

test("threadReplies pulls a whole thread and drops the bot's own header and brief", () => {
  // `conversations.replies` takes any ts in a thread and returns the lot, so the stored brief ts is enough
  // to fetch the human replies. The bot's messages carry `bot_id`, which is how the header and the brief
  // itself are filtered out, leaving only what a person typed back.
  assert.match(slackLib, /export async function threadReplies/);
  assert.match(slackLib, /conversations\.replies\?/);
  assert.match(slackLib, /!message\.bot_id && isRealMessage\(message\)/);
});

test("gatherPriorBriefs reads only delivered internal briefs, newest first, and never throws", () => {
  // Asserted as source because the file imports its neighbours by relative path. Only briefs that were
  // posted to the internal channel have a thread to read, so previews and failed sends are excluded, and
  // an empty answer is the ordinary result for a client's first brief.
  assert.match(runFile, /export async function gatherPriorBriefs/);
  assert.match(runFile, /destination=eq\.internal&status=eq\.success&slack_message_ts=not\.is\.null/);
  assert.match(runFile, /order=created_at\.desc&limit=\$\{PRIOR_BRIEF_COUNT\}/);
  assert.match(runFile, /await threadReplies\(channelId, ts\)/);
  // The read is guarded and the whole function is wrapped, so unreadable Slack degrades to an empty list.
  assert.match(runFile, /\}\s*catch\s*\{\s*return \[\];\s*\}/);
});
