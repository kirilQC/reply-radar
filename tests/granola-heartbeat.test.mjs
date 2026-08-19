// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Granola heartbeat, and the things about it that would go wrong quietly.
 *
 * The whole point of the heartbeat is a verdict the health page can trust: "down" has to mean the hourly
 * poll actually stopped, not that it is three in the morning. That verdict is pure clock arithmetic, so it
 * is asserted directly here — the window edges, the six-hour ceiling, and the rule that staleness is only a
 * fault inside the window. The dedup that stops a call being posted twice is a set membership test, also
 * pure, also here. The route and the worker, which reach outside the process, are checked as source text.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  GRANOLA_TIMEZONE,
  GRANOLA_DOWN_SECONDS,
  inGranolaWindow,
  granolaHeartbeatState,
  selectNewCalls,
} from "../app/lib/granola-heartbeat.ts";

const heartbeatRoute = readFileSync(new URL("../app/api/granola/heartbeat/route.ts", import.meta.url), "utf8");
const callRoute = readFileSync(new URL("../app/api/slack/call-analysis/route.ts", import.meta.url), "utf8");
const healthRoute = readFileSync(new URL("../app/api/heartbeat/route.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/render-worker.mjs", import.meta.url), "utf8");

/** A Date that reads as a given wall-clock hour in New York, whatever the machine's own zone. */
const easternAt = (isoDay, hour) => {
  // Build a UTC time, then correct it so the New York clock reads `hour:00`. Two passes is enough because
  // the offset does not change within an hour.
  let guess = new Date(`${isoDay}T${String(hour).padStart(2, "0")}:00:00Z`);
  for (let i = 0; i < 2; i += 1) {
    const shown = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: GRANOLA_TIMEZONE, hour: "2-digit", hour12: false }).format(guess).slice(0, 2),
    );
    guess = new Date(guess.getTime() + (hour - shown) * 3_600_000);
  }
  return guess;
};

test("the window is open from 5am to 8pm Eastern and closed either side", () => {
  const day = "2026-08-19"; // summer, EDT
  assert.equal(inGranolaWindow(easternAt(day, 4)), false, "4am is before the window");
  assert.equal(inGranolaWindow(easternAt(day, 5)), true, "5am opens the window");
  assert.equal(inGranolaWindow(easternAt(day, 12)), true, "noon is inside");
  assert.equal(inGranolaWindow(easternAt(day, 20)), true, "8pm is the last minute inside");
  assert.equal(inGranolaWindow(easternAt(day, 21)), false, "9pm is after the window");
});

test("the window follows the clock through daylight saving, not a fixed offset", () => {
  // A January morning is EST (-5); the window must still open at the local 5am, not an hour off.
  assert.equal(inGranolaWindow(easternAt("2026-01-15", 5)), true, "5am EST is inside");
  assert.equal(inGranolaWindow(easternAt("2026-01-15", 4)), false, "4am EST is outside");
});

test("state is idle outside the window even when the last poll is old", () => {
  const now = easternAt("2026-08-19", 2); // 2am, window closed
  const result = granolaHeartbeatState({ lastCheckedAt: new Date(now.getTime() - 8 * 3_600_000).toISOString(), now });
  assert.equal(result.state, "idle");
  assert.equal(result.inWindow, false);
});

test("state is starting inside the window when nothing has ever been stored", () => {
  const now = easternAt("2026-08-19", 10);
  const result = granolaHeartbeatState({ lastCheckedAt: null, now });
  assert.equal(result.state, "starting");
  assert.equal(result.ageSeconds, null);
});

test("state is ok inside the window when the last poll is recent", () => {
  const now = easternAt("2026-08-19", 10);
  const result = granolaHeartbeatState({ lastCheckedAt: new Date(now.getTime() - 30 * 60_000).toISOString(), now });
  assert.equal(result.state, "ok");
});

test("state is down only inside the window when the last poll is over six hours stale", () => {
  const now = easternAt("2026-08-19", 15); // 3pm, window open
  const stale = new Date(now.getTime() - (GRANOLA_DOWN_SECONDS + 60) * 1000).toISOString();
  assert.equal(granolaHeartbeatState({ lastCheckedAt: stale, now }).state, "down");

  // The same six-hour-old heartbeat outside the window is idle, not down — the overnight false-red case.
  const night = easternAt("2026-08-19", 3);
  const staleNight = new Date(night.getTime() - (GRANOLA_DOWN_SECONDS + 60) * 1000).toISOString();
  assert.equal(granolaHeartbeatState({ lastCheckedAt: staleNight, now: night }).state, "idle");
});

test("selectNewCalls returns only clients whose call note id has not been posted", () => {
  const sightings = [
    { slug: "willow", noteId: "n1" },
    { slug: "bluevia", noteId: "n2" },
    { slug: "cotool", noteId: null },
  ];
  const posted = new Set(["n1"]);
  assert.deepEqual(selectNewCalls(sightings, posted), ["bluevia"]);
  // Once bluevia is posted too, nothing is new — the same call never posts a second time.
  assert.deepEqual(selectNewCalls(sightings, new Set(["n1", "n2"])), []);
});

test("the heartbeat route stands down outside the window and never polls", () => {
  assert.match(heartbeatRoute, /inGranolaWindow/, "the route checks the window");
  assert.match(heartbeatRoute, /inWindow: false/, "it reports the closed window without polling");
});

test("the heartbeat route keys new calls on the stored call note id", () => {
  assert.match(heartbeatRoute, /signals.*sources.*call|call\.noteId|postedNoteIds/s, "it reads posted note ids");
  assert.match(heartbeatRoute, /selectNewCalls/, "it selects new calls by note id");
});

test("the call analysis route records the call note id so the heartbeat can dedupe on it", () => {
  assert.match(callRoute, /noteId: call\.call\.noteId/, "sources.call carries the Granola note id");
});

test("the worker drives the hourly Granola heartbeat and no longer runs the old daily schedule", () => {
  assert.match(worker, /runGranolaHeartbeat/, "the worker calls the heartbeat");
  assert.match(worker, /\/api\/granola\/heartbeat/, "it hits the heartbeat route");
  assert.match(worker, /GRANOLA_HEARTBEAT_LOOP_MS = 60 \* 60 \* 1000/, "it runs hourly");
  assert.doesNotMatch(worker, /sendDueCallAnalysis/, "the old schedule-driven trigger is gone");
});

test("the health route surfaces a granola heartbeat block and service light", () => {
  assert.match(healthRoute, /granolaHeartbeatState/, "it computes the heartbeat state");
  assert.match(healthRoute, /id: "granola"/, "it adds a granola core service");
  assert.match(healthRoute, /granola,/, "it returns the granola block in the payload");
});
