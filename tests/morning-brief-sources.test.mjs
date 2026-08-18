// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The three things about a scheduled brief that fail without anybody noticing.
 *
 * A wrong figure at least looks wrong to somebody who knows the account. These three do not:
 *
 *  · The wrong client's call. Matching is on words in the meeting title, and a rule one character too
 *    loose puts Bluevia's call in Cotool's brief — and the brief will read perfectly.
 *  · The wrong morning. "Eight Eastern" is a different number of hours from UTC in July than in
 *    January, so anything that stores an offset sends Monday's brief on Sunday night for half the
 *    year, and nobody files that as a bug — they just stop trusting the timing.
 *  · A brief that quietly lost a source. Readiness is the only thing standing between "two sources"
 *    and a post that reads exactly like three.
 *
 * None of the three throws when it is wrong, so all three are computed in files with no relative
 * imports and asserted on here.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { callAgeDays, describeNeedles, normalizeNote, parseTitleNeedles, pickLatestCall, titleMatches, transcriptText } from "../app/lib/granola-match.ts";
import {
  alreadySentToday,
  DEFAULT_SCHEDULE,
  describeSchedule,
  isDueNow,
  localDayKey,
  localMinutes,
  localWeekday,
  readinessOf,
} from "../app/lib/morning-brief-schedule.ts";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../supabase/migrations/20260817_morning_brief_sources.sql", import.meta.url), "utf8");
const titleMigration = readFileSync(new URL("../supabase/migrations/20260817_granola_title_match.sql", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/render-worker.mjs", import.meta.url), "utf8");

// ── Which call belongs to which client ───────────────────────────────

test("a client's own name is what gets looked for, with no configuration", () => {
  // The point of the fallback: twelve clients, and nobody should have to fill in a field to get this.
  assert.deepEqual(parseTitleNeedles("", "Bluevia"), [["bluevia"]]);
  assert.deepEqual(parseTitleNeedles(null, "Cotool"), [["cotool"]]);
  // "Vitalic Health" is invited as "Vitalic", so the phrase and its distinctive word both count.
  assert.deepEqual(parseTitleNeedles("", "Vitalic Health"), [["vitalic", "health"], ["vitalic"]]);
  assert.deepEqual(parseTitleNeedles("Willow, Webrix", "Willow"), [["willow"], ["webrix"]]);
});

test("a name too short or too generic to identify anybody is refused", () => {
  // A needle of "qc" matches every meeting we have, and a needle of "health" matches four clients.
  assert.deepEqual(parseTitleNeedles("QC", ""), []);
  assert.deepEqual(parseTitleNeedles("Health", ""), []);
  assert.deepEqual(parseTitleNeedles("", ""), []);
  assert.deepEqual(parseTitleNeedles(null, null), []);
});

test("titles match on whole words, so a short name cannot be a substring of another", () => {
  const ema = parseTitleNeedles("", "Ema");
  assert.equal(titleMatches("QC Onboarding <> Ema", ema), true);
  // The failure this exists to prevent: "Ema" claiming every meeting with "Email" in the name, and
  // Emma's one-to-one along with it.
  assert.equal(titleMatches("Email deliverability review", ema), false);
  assert.equal(titleMatches("Client kickoff — Kudo, Emma, and Vitalik", ema), false);
});

test("the real titles from the account match the real client names", () => {
  const cases = [
    ["QC <> Bluevia Weekly", "Bluevia"],
    ["Cotool <> QC Weekly", "Cotool"],
    ["Steadywell <> QC Weekly", "Steadywell"],
    ["QC - Willow Weekly Team Sync ", "Willow"],
    ["Kuddo: QC Onboarding ", "Kuddo"],
    ["QC Growth <> Vitalic Kickoff Pt. 2", "Vitalic Health"],
  ];
  for (const [title, name] of cases) {
    assert.equal(titleMatches(title, parseTitleNeedles("", name)), true, `${name} should match ${title}`);
  }
  // Our internal meetings name no client and must claim none of them.
  for (const title of ["Weekly Eng/Ops Sync", "QC Sales Leadership Brainstorm", "[QC Monthly] GTM Engineering Show & Tell"]) {
    for (const [, name] of cases) {
      assert.equal(titleMatches(title, parseTitleNeedles("", name)), false, `${name} should not match ${title}`);
    }
  }
});

test("one client's call never lands in another client's brief", () => {
  assert.equal(titleMatches("QC <> Bluevia Weekly", parseTitleNeedles("", "Cotool")), false);
  assert.equal(titleMatches("Cotool <> QC Weekly", parseTitleNeedles("", "Bluevia")), false);
});

test("the newest matching call wins, and a non-matching one never does", () => {
  const notes = [
    { id: "a", title: "QC <> Bluevia Weekly", created_at: "2026-08-10T14:00:00Z" },
    { id: "b", title: "QC - Willow Weekly Team Sync", created_at: "2026-08-14T14:00:00Z" },
    { id: "c", title: "Internal standup", created_at: "2026-08-16T14:00:00Z" },
  ];
  assert.equal(pickLatestCall(notes, parseTitleNeedles("", "Willow"))?.id, "b");
  assert.equal(pickLatestCall(notes, parseTitleNeedles("", "Bluevia"))?.id, "a");
  assert.equal(pickLatestCall(notes, parseTitleNeedles("", "Cotool")), null);
  // No needles must never mean "match anything" — that would put a random meeting in every brief.
  assert.equal(pickLatestCall(notes, []), null);
  assert.equal(pickLatestCall([], parseTitleNeedles("", "Willow")), null);
});

test("the meeting's own time beats the time the note was written", () => {
  // A note written up the next morning would otherwise date the call to the wrong day, and "we said we
  // would" in a brief is an argument about dates.
  const note = normalizeNote({
    id: "a",
    title: "QC <> Bluevia Weekly",
    created_at: "2026-08-13T09:00:00Z",
    calendar_event: { scheduled_start_time: "2026-08-12T19:00:00Z" },
  });
  assert.equal(new Date(note.startedAt).toISOString(), "2026-08-12T19:00:00.000Z");
});

test("a note with no id is not a call", () => {
  assert.equal(normalizeNote({}), null);
  assert.equal(normalizeNote(null), null);
});

test("needles read back the way somebody would say them", () => {
  assert.equal(describeNeedles(parseTitleNeedles("", "Vitalic Health")), "vitalic health or vitalic");
  assert.equal(describeNeedles([]), "");
});

test("a call's age is whole days, and the future is not negative days ago", () => {
  const now = Date.UTC(2026, 7, 17, 12, 0, 0);
  assert.equal(callAgeDays(Date.UTC(2026, 7, 17, 9, 0, 0), now), 0);
  assert.equal(callAgeDays(Date.UTC(2026, 7, 14, 12, 0, 0), now), 3);
  assert.equal(callAgeDays(Number.NaN, now), null);
});

test("a transcript is flattened whichever shape it arrives in", () => {
  assert.equal(transcriptText("just text"), "just text");
  assert.equal(transcriptText({ transcript: " padded " }), "padded");
  // Speaker tags are kept: a brief that attributes a commitment to the wrong side of the call is worse
  // than one that does not attribute it at all.
  assert.equal(
    transcriptText({ segments: [{ speaker: "Dana", text: "we need the new sequence" }, { speaker: "Kiril", text: "by Thursday" }] }),
    "Dana: we need the new sequence\nKiril: by Thursday",
  );
  assert.equal(transcriptText({}), "");
});

// ── Which morning, in which zone ─────────────────────────────────────

test("the local day and clock come from the zone, not from an offset", () => {
  // 01:30 UTC on a Monday is still Sunday evening in New York, and a brief scheduled for Monday must
  // not go out then. This is the assertion that any offset arithmetic fails.
  const lateSundayInNewYork = new Date("2026-08-17T01:30:00Z");
  assert.equal(localDayKey(lateSundayInNewYork, "America/New_York"), "2026-08-16");
  assert.equal(localWeekday(lateSundayInNewYork, "America/New_York"), 0);
  assert.equal(localMinutes(lateSundayInNewYork, "America/New_York"), 21 * 60 + 30);
});

test("summer and winter are different offsets from the same zone", () => {
  // Four hours in August, five in January. A stored offset gets one of these two wrong, always.
  assert.equal(localMinutes(new Date("2026-08-17T12:00:00Z"), "America/New_York"), 8 * 60);
  assert.equal(localMinutes(new Date("2026-01-19T13:00:00Z"), "America/New_York"), 8 * 60);
});

const MWF = { ...DEFAULT_SCHEDULE, enabled: true };

test("a brief is due on its own days, at or after its own time", () => {
  // Monday 2026-08-17, 08:00 New York is 12:00 UTC.
  assert.equal(isDueNow(MWF, new Date("2026-08-17T12:00:00Z")), true);
  assert.equal(isDueNow(MWF, new Date("2026-08-17T11:59:00Z")), false);
  // Still due at 08:40, because the worker is not guaranteed to be awake at exactly 08:00 and a brief
  // that silently skips a day because of a deploy is worse than one that lands forty minutes late.
  assert.equal(isDueNow(MWF, new Date("2026-08-17T12:40:00Z")), true);
  // Tuesday is not one of its days.
  assert.equal(isDueNow(MWF, new Date("2026-08-18T12:00:00Z")), false);
  assert.equal(isDueNow({ ...MWF, enabled: false }, new Date("2026-08-17T12:00:00Z")), false);
});

test("the automation is off until somebody turns it on", () => {
  // Nobody should be able to add a client on Tuesday and have it post on Wednesday morning, and a
  // newly enabled schedule must not reach a client-facing channel before a human has read one brief.
  assert.equal(DEFAULT_SCHEDULE.enabled, false);
  assert.equal(DEFAULT_SCHEDULE.destination, "test");
  assert.equal(isDueNow(DEFAULT_SCHEDULE, new Date("2026-08-17T12:00:00Z")), false);
});

test("already sent today is judged in the schedule's zone", () => {
  const now = new Date("2026-08-17T12:00:00Z");
  assert.equal(alreadySentToday("2026-08-17T11:00:00Z", MWF, now), true);
  // 03:00 UTC Monday is 23:00 Sunday in New York, so this was not today and must not block today's.
  assert.equal(alreadySentToday("2026-08-17T03:00:00Z", MWF, now), false);
  assert.equal(alreadySentToday(null, MWF, now), false);
  assert.equal(alreadySentToday("not a date", MWF, now), false);
});

test("the schedule reads back as the sentence above the controls", () => {
  assert.equal(describeSchedule(MWF), "Mon, Wed, Fri at 8:00 AM New York");
  assert.equal(describeSchedule({ ...MWF, sendDays: [0, 1, 2, 3, 4, 5, 6] }), "Every day at 8:00 AM New York");
  assert.equal(describeSchedule({ ...MWF, sendHour: 13, sendMinute: 30 }), "Mon, Wed, Fri at 1:30 PM New York");
  assert.equal(describeSchedule({ ...MWF, sendHour: 0 }), "Mon, Wed, Fri at 12:00 AM New York");
});

// ── Whether all three sources are actually there ─────────────────────

const READY = {
  heyreachKeyConfigured: true,
  lastSuccessfulPollAt: "2026-08-17T11:00:00Z",
  internalChannelId: "C09INTERNAL",
  externalChannelId: "C09EXTERNAL",
  granolaTitleMatch: "Willow",
  granolaKeyCount: 3,
};
const NOW = Date.parse("2026-08-17T12:00:00Z");

test("all three present is ready", () => {
  const readiness = readinessOf(READY, NOW);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.heyreach.ok, true);
  assert.equal(readiness.granola.detail, "3 keys · matching \u201CWillow\u201D");
});

test("a HeyReach key that stopped reporting is not a working source", () => {
  // The failure this catches: the key is still stored, so a check that only asked "is a key set" would
  // show a live connection while the brief quoted figures from three days ago.
  assert.equal(readinessOf({ ...READY, lastSuccessfulPollAt: "2026-08-14T11:00:00Z" }, NOW).heyreach.ok, false);
  assert.equal(readinessOf({ ...READY, lastSuccessfulPollAt: null }, NOW).heyreach.detail, "Never polled");
  assert.equal(readinessOf({ ...READY, heyreachKeyConfigured: false }, NOW).heyreach.detail, "No HeyReach key");
});

test("no internal channel is a failure, one missing external channel is not", () => {
  // Internal is where the team's commitments are and where a brief posts, so without it there is
  // nothing to read and nowhere to put the result. External costs the brief one section.
  assert.equal(readinessOf({ ...READY, internalChannelId: "" }, NOW).slack.ok, false);
  const externalMissing = readinessOf({ ...READY, externalChannelId: "" }, NOW);
  assert.equal(externalMissing.slack.ok, true);
  assert.equal(externalMissing.slack.detail, "Internal only");
  assert.equal(externalMissing.ready, true);
});

test("a key with no name to match on, and a name with no key, are both not ready", () => {
  assert.equal(readinessOf({ ...READY, granolaTitleMatch: "  " }, NOW).granola.ok, false);
  assert.equal(readinessOf({ ...READY, granolaKeyCount: 0 }, NOW).granola.detail, "No Granola keys added");
  assert.equal(readinessOf({ ...READY, granolaKeyCount: 0 }, NOW).ready, false);
});

// ── What has to exist for any of the above to run ────────────────────

test("the schema and the migration agree on the new columns and tables", () => {
  for (const needed of ["morning_brief_enabled", "rr_granola_keys", "rr_slack_automations"]) {
    assert.ok(schema.includes(needed), `schema.sql is missing ${needed}`);
    assert.ok(migration.includes(needed), `the migration is missing ${needed}`);
  }
  // The column the matcher actually reads, and the dead one it replaced.
  assert.ok(schema.includes("granola_title_match"), "schema.sql is missing granola_title_match");
  assert.ok(titleMigration.includes("add column if not exists granola_title_match"));
  assert.ok(!schema.includes("granola_domains"), "schema.sql still declares granola_domains");
  // Everything additive, so the migration can be run against a live database twice.
  assert.ok(migration.includes("add column if not exists"));
  assert.ok(migration.includes("create table if not exists"));
});

test("the worker sends one brief per cycle and asks the app which one", () => {
  // Twelve concurrent briefs would be twelve model calls and twelve bursts at Granola's rate limit,
  // and would look like twelve broken clients. The guard is that only the first due slug is posted.
  assert.ok(worker.includes("const slug = due[0];"), "the worker should post only the first due client");
  assert.ok(!/for\s*\(\s*const\s+slug\s+of\s+due\s*\)/.test(worker), "the worker must not loop over the due list");
  // The schedule rules live in one place. A copy here would drift, and drift silently.
  assert.ok(!worker.includes("isDueNow"), "the worker must not recompute whether a brief is due");
});
