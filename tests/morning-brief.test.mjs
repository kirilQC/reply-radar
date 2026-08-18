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
import { gatherSignals, signalsAsText, briefUserContent, morningBriefPromptKey } from "../app/lib/morning-brief.ts";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/slack/brief/route.ts", import.meta.url), "utf8");
const slackLib = readFileSync(new URL("../app/lib/slack.ts", import.meta.url), "utf8");

const WORKSPACE = { id: "w1", name: "Willow", slug: "willow", timezone: "America/New_York" };

/** A reader that answers the two reads `gatherSignals` makes, keyed on which table was asked for. */
const readerFor = (campaigns, days) => async (path) => {
  if (path.startsWith("rr_campaign_stats")) return campaigns;
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
  assert.equal(signals.campaigns.names[0].name, "Founders — NY");
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
    signals: { campaigns: { total: 0, active: 0, paused: 0, names: [] }, sending: { thisWeek: 0, lastWeek: 0, changePercent: null, lastDayWithSends: null, quietDays: 0 }, replies: { thisWeek: 0, lastWeek: 0 }, acceptance: { thisWeek: null, lastWeek: null }, staleness: { statsAgeHours: null, dayCount: 0 } },
    internal: { channelId: "C1", messages: 0, text: "", error: "The Reply Radar bot is not in that channel. Invite it, then try again." },
    external: { channelId: "", messages: 0, text: "" },
  });
  assert.match(content, /bot is not in that channel/);
  assert.match(content, /Say so in one line/);
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
  assert.match(slackLib, /}, "write"\);/);
  assert.match(slackLib, /const token = actor === "write" \? botToken\(\) : readToken\(\);/);
  // One `"write"` call site, and it is the posting one.
  assert.equal(slackLib.match(/, "write"\)/g)?.length, 1);
  assert.match(slackLib, /chat\.postMessage[\s\S]{0,700}}, "write"\);/);
});

test("reading prefers a teammate's token, and says so when neither is set", () => {
  // A bot can only read a channel it was invited to, and the external channels are shared with the
  // client, where adding an app is not our decision to make.
  assert.match(slackLib, /export function readToken\(\)[\s\S]{0,80}return userToken\(\) \|\| botToken\(\);/);
  assert.match(slackLib, /Neither \$\{SLACK_USER_TOKEN_ENV\} nor \$\{SLACK_TOKEN_ENV\}/);
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
