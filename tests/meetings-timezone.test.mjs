// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * A start time with no offset was read in the server's zone (UTC), so "10:00 AM" from a Zap filed as 6 AM
 * Eastern. It only ever shows up as a wrong time, never an error, so it is pinned here.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseWhen, normalizeMeeting } from "../shared/meetings.mjs";

test("parseWhen reads a zoneless time as New York wall-clock time", () => {
  assert.equal(parseWhen("2026-08-19T10:00"), "2026-08-19T14:00:00.000Z"); // EDT, UTC-4
  assert.equal(parseWhen("August 19, 2026 @ 10:00 AM"), "2026-08-19T14:00:00.000Z");
  assert.equal(parseWhen("January 5, 2026 10:00 AM"), "2026-01-05T15:00:00.000Z"); // EST, UTC-5
  assert.equal(parseWhen("2026-08-19"), "2026-08-19T04:00:00.000Z"); // midnight Eastern
});

test("parseWhen leaves an explicit zone or offset alone", () => {
  assert.equal(parseWhen("2026-08-19T14:00:00.000Z"), "2026-08-19T14:00:00.000Z");
  assert.equal(parseWhen("2026-08-19T10:00:00-07:00"), "2026-08-19T17:00:00.000Z");
  assert.equal(parseWhen("August 19, 2026 @ 10:00 AM EST"), "2026-08-19T15:00:00.000Z");
  assert.equal(parseWhen("August 19, 2026 10:00 AM GMT"), "2026-08-19T10:00:00.000Z");
});

test("a webhook's zoneless start time lands on Eastern time", () => {
  const { fields } = normalizeMeeting({ client: "Acme", name: "Jane", start_time: "2026-11-03 09:30" });
  assert.equal(fields.meeting_at, "2026-11-03T14:30:00.000Z");
  assert.equal(fields.when_text, "2026-11-03 09:30");
});
