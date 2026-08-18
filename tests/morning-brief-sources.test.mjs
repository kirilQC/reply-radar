// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The three things about a scheduled brief that fail without anybody noticing.
 *
 * A wrong figure at least looks wrong to somebody who knows the account. These three do not:
 *
 *  · The wrong client's call. Matching is on attendee email domains, and a domain rule that is one
 *    character too loose puts Bluevia's call in Cotool's brief — and the brief will read perfectly.
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
import { callAgeDays, noteDomains, normalizeNote, parseDomains, pickLatestCall, transcriptText } from "../app/lib/granola-match.ts";
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
const worker = readFileSync(new URL("../worker/render-worker.mjs", import.meta.url), "utf8");

// ── Which call belongs to which client ───────────────────────────────

test("a domain list is read out of whatever was typed", () => {
  assert.deepEqual(parseDomains("webrix.ai"), ["webrix.ai"]);
  assert.deepEqual(parseDomains("emaapp.co, emahealth.ai"), ["emaapp.co", "emahealth.ai"]);
  assert.deepEqual(parseDomains("Dana@Webrix.AI"), ["webrix.ai"]);
  assert.deepEqual(parseDomains("blueviahealth.com; cotool.ai getsteadywell.com"), ["blueviahealth.com", "cotool.ai", "getsteadywell.com"]);
});

test("a single label is refused, because it would match every meeting", () => {
  // "qc" or "weekly" typed into the domains field is the mistake that silently matches everything.
  assert.deepEqual(parseDomains("qc"), []);
  assert.deepEqual(parseDomains("weekly"), []);
  assert.deepEqual(parseDomains("Webrix"), []);
  assert.deepEqual(parseDomains(""), []);
  assert.deepEqual(parseDomains(null), []);
});

test("a domain is never taken from the body of a call", () => {
  // "I'll email fred@othercompany.com" is not evidence that anyone from othercompany.com attended,
  // and treating it as evidence is how one client's transcript lands in another client's brief.
  const found = noteDomains({
    attendees: [{ email: "dana@webrix.ai" }],
    summary_markdown: "Dana will loop in fred@blueviahealth.com after the call.",
    transcript: "kori@qcgrowth.com: sounds good",
  });
  assert.deepEqual(found, ["webrix.ai"]);
});

test("attendees are read out of the calendar event too", () => {
  const found = noteDomains({ google_calendar_event: { attendees: [{ email: "Ari@Cotool.ai" }, { email: "kiril@qcgrowth.com" }] } });
  assert.deepEqual(found.sort(), ["cotool.ai", "qcgrowth.com"]);
});

test("the newest matching call wins, and a non-matching one never does", () => {
  const notes = [
    { id: "a", title: "QC <> Bluevia Weekly", created_at: "2026-08-10T14:00:00Z", attendees: [{ email: "sam@blueviahealth.com" }] },
    { id: "b", title: "QC - Willow Weekly Team Sync", created_at: "2026-08-14T14:00:00Z", attendees: [{ email: "dana@webrix.ai" }] },
    { id: "c", title: "Internal standup", created_at: "2026-08-16T14:00:00Z", attendees: [{ email: "kiril@qcgrowth.com" }] },
  ];
  // The title says Willow and the attendees say Webrix. The attendees are what decides.
  assert.equal(pickLatestCall(notes, ["webrix.ai"])?.id, "b");
  assert.equal(pickLatestCall(notes, ["blueviahealth.com"])?.id, "a");
  assert.equal(pickLatestCall(notes, ["cotool.ai"]), null);
  assert.equal(pickLatestCall([], ["webrix.ai"]), null);
});

test("a note with no start time and no attendees is not a call", () => {
  assert.equal(normalizeNote({}), null);
  assert.equal(normalizeNote(null), null);
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
  granolaDomains: "webrix.ai",
  granolaKeyCount: 3,
};
const NOW = Date.parse("2026-08-17T12:00:00Z");

test("all three present is ready", () => {
  const readiness = readinessOf(READY, NOW);
  assert.equal(readiness.ready, true);
  assert.equal(readiness.heyreach.ok, true);
  assert.equal(readiness.granola.detail, "3 keys · domains set");
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

test("a key with no domains, and domains with no key, are both not ready", () => {
  assert.equal(readinessOf({ ...READY, granolaDomains: "  " }, NOW).granola.ok, false);
  assert.equal(readinessOf({ ...READY, granolaKeyCount: 0 }, NOW).granola.detail, "No Granola keys added");
  assert.equal(readinessOf({ ...READY, granolaKeyCount: 0 }, NOW).ready, false);
});

// ── What has to exist for any of the above to run ────────────────────

test("the schema and the migration agree on the new columns and tables", () => {
  for (const needed of ["granola_domains", "morning_brief_enabled", "rr_granola_keys", "rr_slack_automations"]) {
    assert.ok(schema.includes(needed), `schema.sql is missing ${needed}`);
    assert.ok(migration.includes(needed), `the migration is missing ${needed}`);
  }
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
