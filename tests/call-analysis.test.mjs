// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The call analysis, and the things about it that would go wrong quietly.
 *
 * It is the morning brief's sibling — one Anthropic call over a transcript, posted to Slack — so the
 * failures are the same shape: a prompt that stops producing the heading format the website parses, a
 * readiness check that lets a client with no channel switch on, a content builder that hands the model a
 * transcript with the attendee list stripped so it attributes an action item to nobody. The arithmetic
 * half is pure and asserted directly; the route, which imports its neighbours by relative path, is
 * checked as source text the way the morning brief's route is.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  callAnalysisPromptKey,
  callAnalysisHeaderText,
  callAnalysisUserContent,
  callAnalysisRow,
  DEFAULT_CALL_ANALYSIS_PROMPT,
} from "../app/lib/call-analysis.ts";
import { callReadinessOf } from "../app/lib/morning-brief-schedule.ts";

const route = readFileSync(new URL("../app/api/slack/call-analysis/route.ts", import.meta.url), "utf8");
const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/render-worker.mjs", import.meta.url), "utf8");

const WORKSPACE = { id: "w1", name: "Willow", slug: "willow", timezone: "America/New_York", client_brief: "Willow sells sustainable furniture." };

const CALL = {
  noteId: "n1",
  title: "Willow <> QC Weekly",
  startedAt: "2026-08-19T16:00:00.000Z",
  ageDays: 0,
  owner: "Kiril",
  attendees: ["Kiril", "Dana"],
  durationMinutes: 42,
  transcript: "Kiril: let's launch the new campaign. Dana: I'll send the leads by Friday.",
  truncated: false,
};

test("the prompt key is global by default and scoped when a slug is given", () => {
  assert.equal(callAnalysisPromptKey(), "call_analysis_prompt");
  assert.equal(callAnalysisPromptKey("willow"), "call_analysis_prompt_willow");
});

test("the default prompt keeps the exact heading format the website parses", () => {
  // Underscores and asterisks are load-bearing: change them and a heading renders as a plain line.
  assert.match(DEFAULT_CALL_ANALYSIS_PROMPT, /\*:dart: _Action Items_ :dart:\*/);
  assert.match(DEFAULT_CALL_ANALYSIS_PROMPT, /\*:moneybag: _Deals_ :moneybag:\*/);
  assert.match(DEFAULT_CALL_ANALYSIS_PROMPT, /\*:signal_strength: _Campaigns_ :signal_strength:\*/);
});

test("the prompt orders the sections campaigns, deals, action items, discussed, next steps", () => {
  const order = ["Campaigns", "Deals", "Action Items", "Discussed", "Next Steps"].map((name) => DEFAULT_CALL_ANALYSIS_PROMPT.indexOf(`_${name}_`));
  for (const at of order) assert.ok(at > -1, "a section heading is missing");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "the sections are not in the intended order");
});

test("the prompt bans the em dash and forbids double-asterisk bold, like the brief", () => {
  // The formatting must match the morning brief: Slack mrkdwn, no em dashes, single-asterisk bold.
  assert.match(DEFAULT_CALL_ANALYSIS_PROMPT, /Never use an em dash/);
  assert.match(DEFAULT_CALL_ANALYSIS_PROMPT, /no underline in Slack/i);
});

test("the header names the client and the day of the call, threaded, with no weekday", () => {
  const header = callAnalysisHeaderText(WORKSPACE, new Date("2026-08-19T16:00:00.000Z"));
  assert.match(header, /Willow Weekly Sync Recap \(August 19th\)/);
  assert.match(header, /:thread:/);
  // No weekday, unlike the morning brief: a recap is dated by the calendar day of the meeting.
  assert.doesNotMatch(header, /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/);
});

test("the content hands the model the transcript, the attendees and the client context", () => {
  const content = callAnalysisUserContent(WORKSPACE, { call: CALL });
  assert.match(content, /I'll send the leads by Friday/);
  assert.match(content, /Kiril, Dana/);
  assert.match(content, /sustainable furniture/);
  assert.match(content, /42 minutes/);
});

test("the content hands the model a mention roster and the brain, the way the brief does", () => {
  const content = callAnalysisUserContent(WORKSPACE, {
    call: CALL,
    brain: "# QC Brain\n\nWillow is scaling ASC outbound.",
    people: [{ id: "U01", name: "Kiril" }, { id: "U02", name: "Dana" }],
  });
  // The roster is name → mention code, copied verbatim so the owner is actually notified.
  assert.match(content, /How to mention people/);
  assert.match(content, /Kiril → <@U01>/);
  assert.match(content, /Dana → <@U02>/);
  // The QC Brain rides along as standing context, the same block the morning brief is given.
  assert.match(content, /Willow is scaling ASC outbound\./);
});

test("with no call, the content tells the model to say so and stop", () => {
  const content = callAnalysisUserContent(WORKSPACE, { call: null, callReason: "Granola had nothing recent." });
  assert.match(content, /Granola had nothing recent\./);
  assert.match(content, /no call was found/i);
});

test("readiness needs an internal channel and a Granola key, and no HeyReach", () => {
  const ready = callReadinessOf({ internalChannelId: "C1", externalChannelId: "", granolaTitleMatch: "Willow", granolaKeyCount: 1 });
  assert.equal(ready.ready, true);
  // A call analysis has no HeyReach source at all.
  assert.equal(ready.heyreach, undefined);

  const noChannel = callReadinessOf({ internalChannelId: "", externalChannelId: "C2", granolaTitleMatch: "Willow", granolaKeyCount: 1 });
  assert.equal(noChannel.ready, false);
  assert.equal(noChannel.slack.ok, false);

  const noKey = callReadinessOf({ internalChannelId: "C1", externalChannelId: "", granolaTitleMatch: "Willow", granolaKeyCount: 0 });
  assert.equal(noKey.ready, false);
  assert.equal(noKey.granola.ok, false);
});

test("the route is the second automation, may reach the external channel, and logs to the shared table", () => {
  assert.match(route, /const AUTOMATION = "call_analysis"/);
  // Unlike the brief, external is an allowed destination.
  assert.match(route, /\["test", "internal", "external"\]\.includes/);
  assert.match(route, /slack_external_channel_id/);
  // Reuses the brief's framing and the shared log table rather than inventing its own.
  assert.match(route, /briefFraming/);
  assert.match(route, /rr_slack_briefs/);
});

test("the route files the recap into the client's Weekly Calls table after posting", () => {
  assert.match(route, /fileWeeklyCall/);
  // Files from the mapped base, and the note it returns rides along in the trace, never a failed recap.
  assert.match(route, /airtable_base_id/);
  assert.match(route, /filingNotes/);
});

const WEEKLY_CALL_ROW = callAnalysisRow(WORKSPACE, { call: CALL, recap: "1. do the thing", destination: "internal", syncedAt: new Date("2026-08-21T10:00:00.000Z") });

test("a Weekly Calls row carries the call's facts and is keyed on the Granola note id", () => {
  assert.equal(WEEKLY_CALL_ROW["Call ID"], "n1");
  assert.equal(WEEKLY_CALL_ROW.Title, "Willow <> QC Weekly");
  assert.equal(WEEKLY_CALL_ROW.Attendees, "Kiril, Dana");
  assert.equal(WEEKLY_CALL_ROW.Host, "Kiril");
  assert.equal(WEEKLY_CALL_ROW["Duration (min)"], 42);
  assert.equal(WEEKLY_CALL_ROW.Recap, "1. do the thing");
  // The day of the call in the client's zone, not the day it was filed.
  assert.equal(WEEKLY_CALL_ROW["Call Date"], "2026-08-19");
  assert.equal(WEEKLY_CALL_ROW["Last Synced"], "2026-08-21");
});

test("the row's Posted To is one of the four options the table offers", () => {
  assert.equal(WEEKLY_CALL_ROW["Posted To"], "Internal");
  assert.equal(callAnalysisRow(WORKSPACE, { call: CALL, recap: "x", destination: "preview" })["Posted To"], "Preview");
  assert.equal(callAnalysisRow(WORKSPACE, { call: CALL, recap: "x", destination: "external" })["Posted To"], "External");
});

test("a field with nothing to say is left off the row rather than written blank", () => {
  const bare = callAnalysisRow(WORKSPACE, { call: { ...CALL, attendees: [], owner: "", durationMinutes: 0 }, recap: "x", destination: "test" });
  assert.ok(!("Attendees" in bare), "an empty attendee list should not be written");
  assert.ok(!("Host" in bare), "an empty host should not be written");
  assert.ok(!("Duration (min)" in bare), "a zero-minute duration is not a real call length");
});

test("the enabling column exists and the worker drains the call-analysis queue one client per cycle", () => {
  assert.match(schema, /call_analysis_enabled boolean not null default false/);
  assert.match(worker, /sendDueCallAnalysis/);
  assert.match(worker, /api\/slack\/call-analysis/);
});
