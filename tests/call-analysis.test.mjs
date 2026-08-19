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

test("the header names the client and the automation", () => {
  const header = callAnalysisHeaderText(WORKSPACE, new Date("2026-08-19T16:00:00.000Z"));
  assert.match(header, /Willow Call Analysis/);
  assert.match(header, /:clipboard:/);
});

test("the content hands the model the transcript, the attendees and the client context", () => {
  const content = callAnalysisUserContent(WORKSPACE, { call: CALL });
  assert.match(content, /I'll send the leads by Friday/);
  assert.match(content, /Kiril, Dana/);
  assert.match(content, /sustainable furniture/);
  assert.match(content, /42 minutes/);
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

test("the enabling column exists and the worker drains the call-analysis queue one client per cycle", () => {
  assert.match(schema, /call_analysis_enabled boolean not null default false/);
  assert.match(worker, /sendDueCallAnalysis/);
  assert.match(worker, /api\/slack\/call-analysis/);
});
