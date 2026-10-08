// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clientSchedule, DEFAULT_SCHEDULE, isDueNow } from "../app/lib/morning-brief-schedule.ts";

const shared = { ...DEFAULT_SCHEDULE, enabled: true, sendDays: [1, 3, 5], sendHour: 8, sendMinute: 0, timezone: "America/New_York" };

test("a client with its own schedule posts on its days only (Velora: Wednesdays at 8am)", () => {
  const own = clientSchedule(shared, { brief_schedule: { sendDays: [3], sendHour: 8, sendMinute: 0 } }, "brief_schedule");
  assert.equal(own.custom, true);
  assert.deepEqual(own.sendDays, [3]);
  // Wed 8 Oct 2026, 8:30am New York = 12:30 UTC; Fri 9 Oct same time.
  assert.equal(isDueNow(own, new Date("2026-10-07T12:30:00Z")), true, "Wednesday morning is due");
  assert.equal(isDueNow(own, new Date("2026-10-09T12:30:00Z")), false, "Friday is no longer a brief day for this client");
  assert.equal(isDueNow(shared, new Date("2026-10-09T12:30:00Z")), true, "everyone else still gets Friday");
});

test("a client without its own schedule follows the shared one, and a partial override keeps the rest", () => {
  assert.equal(clientSchedule(shared, {}, "brief_schedule").custom, false);
  const timeOnly = clientSchedule(shared, { brief_schedule: { sendHour: 10, sendMinute: 30 } }, "brief_schedule");
  assert.deepEqual(timeOnly.sendDays, [1, 3, 5]);
  assert.equal(timeOnly.sendHour, 10);
});

test("the shared on/off switch still stops a client with its own schedule", () => {
  const own = clientSchedule({ ...shared, enabled: false }, { brief_schedule: { sendDays: [3] } }, "brief_schedule");
  assert.equal(isDueNow(own, new Date("2026-10-07T12:30:00Z")), false);
});

test("both report routes judge each client on its own schedule, and QC Bot has the tool", () => {
  for (const [path, key] of [["../app/api/slack/brief/route.ts", "morning_brief"], ["../app/api/slack/eow-report/route.ts", "eow_report"]]) {
    const route = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(route, new RegExp(`clientSchedule\\(schedule, workspace\\.guardrails, SCHEDULE_OVERRIDE_KEYS\\.${key}\\)`));
    assert.match(route, /dueNow: isDueNow\(own, now\) && enabled/);
  }
  assert.match(readFileSync(new URL("../app/lib/assistant-tools.ts", import.meta.url), "utf8"), /case "report_schedule":/);
});
