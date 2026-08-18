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
import { briefHeaderText, briefTrace, DEFAULT_MORNING_BRIEF_PROMPT, gatherSignals, signalsAsText, briefUserContent, morningBriefPromptKey } from "../app/lib/morning-brief.ts";
import { transcript } from "../app/lib/slack.ts";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/slack/brief/route.ts", import.meta.url), "utf8");
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
  // Named where the daily figures have seen the account, and left as the id where they have not — an id is
  // still enough to go and look, and inventing a name would be worse.
  assert.match(text, /Senders on it: Kori Katz, Dan Shapiro, s3, s4\./);
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
  assert.match(signalsAsText(signals), /no leads left to contact, so it is done sending/);
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
  assert.match(text, /No senders are recorded on it/);
  assert.match(text, /Total days of sending left cannot be worked out/);
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
    signals: { campaigns: { total: 0, active: 0, paused: 0, finished: 0, names: [] }, runway: { daysLeft: null, pending: 0, senders: 0, needsCampaigns: false }, sending: { thisWeek: 0, lastWeek: 0, changePercent: null, lastDayWithSends: null, quietDays: 0 }, replies: { thisWeek: 0, lastWeek: 0 }, acceptance: { thisWeek: null, lastWeek: null }, staleness: { statsAgeHours: null, dayCount: 0 } },
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
  // Exactly one `call()` asks for the write credential, and it is the one that posts.
  assert.equal(slackLib.match(/\}, "write"\);/g)?.length, 1);
  assert.match(slackLib, /chat\.postMessage[\s\S]{0,700}\}, "write"\);/);
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
  assert.match(header, /Willow — morning brief/);
  assert.match(header, /Monday, August 17/);
  assert.match(header, /in this thread/);
  // Two lines. The whole reason for the split is that the channel gets one glanceable line, so a header
  // that grew into a summary of the brief would have defeated it.
  assert.equal(header.split("\n").length, 2);
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
  // Once each, though. The first run of this printed the contradiction in *Start here* and again as an
  // owned item below it, which is the same block of text the reader was already skipping.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /not repeated\* lower down/);
});

test("the brief is told to mention people and to name campaigns in full", () => {
  // Two reversals of the old prompt, which forbade mentions outright and let a campaign be called by its
  // prefix. "BV007" does not tell the reader which campaign it is, so the item cannot be acted on.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /Mention people with their mention code/);
  assert.doesNotMatch(DEFAULT_MORNING_BRIEF_PROMPT, /the brief must not ping anybody/);
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /Campaign names in full/);
  // Slack has no underline. Asked for one, the model reaches for markdown that renders as literal characters.
  assert.match(DEFAULT_MORNING_BRIEF_PROMPT, /There is no underline in Slack/);
  // Sections, each with its own heading line, because the complaint was that it arrived as one block.
  for (const heading of [":rotating_light: \\*Start here\\*", ":clipboard: \\*What we owe them\\*", ":chart_with_upwards_trend: \\*HeyReach right now\\*", ":hourglass: \\*Waiting on the client\\*"]) {
    assert.match(DEFAULT_MORNING_BRIEF_PROMPT, new RegExp(heading));
  }
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
};

const OUTCOME = { model: "claude-sonnet-4-6", promptChars: 6_000, contentChars: 48_000, briefChars: 1_400, destination: "preview", channelId: "", posted: false };

/** The step for one system, so a test can assert on it without depending on the order. */
const stepFor = (steps, source) => steps.find((step) => step.source === source);

test("a run that used all three sources says three of three", () => {
  const steps = briefTrace(WORKSPACE, {
    signals: { ...NO_SIGNALS, campaigns: { total: 2, active: 2, paused: 0, finished: 0, names: [] }, staleness: { statsAgeHours: 2, dayCount: 14 } },
    internal: { channelId: "C1", messages: 18, raw: 23, capped: false, text: "10:00 Kiril: shipping today" },
    external: { channelId: "C2", messages: 5, raw: 5, capped: false, text: "09:00 Client: any update?" },
    call: { title: "QC <> Bluevia Weekly", ageDays: 5, owner: "Kiril", startedAt: Date.parse("2026-08-12T19:00:00Z"), attendees: ["Kiril Ivlev", "Dan Shapiro"], durationMinutes: 33, transcript: "Kiril: we will send the list Thursday.", truncated: false },
  }, OUTCOME);

  assert.equal(steps.length, 5);
  assert.deepEqual(steps.map((step) => step.source), ["Slack channels", "Granola", "HeyReach", "Anthropic", "Slack post"]);
  assert.ok(steps.every((step) => step.state === "ok"), `every source was live: ${steps.filter((step) => step.state !== "ok").map((step) => step.source)}`);
  assert.match(stepFor(steps, "Anthropic").result, /Fed 3 of 3 sources to claude-sonnet-4-6/);
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
  assert.match(stepFor(steps, "Anthropic").result, /Fed 0 of 3 sources/);
});

test("figures too old to trust do not read as a working source", () => {
  // Stale figures are the failure that looks like success: every number is present and every one is from
  // Tuesday. A green tick against them is worse than no trace at all.
  const stale = { ...NO_SIGNALS, campaigns: { total: 3, active: 1, paused: 2, finished: 0, names: [] }, staleness: { statsAgeHours: 70, dayCount: 14 } };
  const steps = briefTrace(WORKSPACE, { signals: stale, internal: { channelId: "", messages: 0, text: "" }, external: { channelId: "", messages: 0, text: "" } }, OUTCOME);
  assert.equal(stepFor(steps, "HeyReach").state, "partial");
  assert.match(stepFor(steps, "HeyReach").facts.join(" "), /last collected 70 hours ago/);
});

test("every campaign the model was given is listed, and the ones it was not are counted", () => {
  const names = Array.from({ length: 10 }, (_, index) => ({ name: `Campaign ${index + 1}`, status: "ACTIVE", isActive: true, sent: 100, accepted: 25, replies: 4, pending: 50, senders: ["Kori Katz"], daysLeft: 2 }));
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
  assert.match(route, /const inputs = \{ signals, \.\.\.channels, call: call\.call, callReason: call\.callReason \};/);
  assert.match(route, /const content = briefUserContent\(workspace, inputs\);/);
  assert.match(route, /briefTrace\(workspace, inputs, \{/);
  // Not stored. The excerpts quote every client call verbatim, and the row is kept for a year.
  assert.doesNotMatch(route, /signals: \{ \.\.\.signals, sources, steps/);
});
