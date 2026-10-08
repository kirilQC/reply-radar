// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { burstOf, burstText, laterInBurst } from "../shared/reply-burst.mjs";

const thread = [
  { id: "a1", direction: "outbound", body: "Would love to see you there!", sentAt: "2026-10-08T20:30:00Z" },
  { id: "m4", direction: "inbound", body: "Sounds great", sentAt: "2026-10-08T20:45:50Z" },
  { id: "m5", direction: "inbound", body: "Looking forward to the session.", sentAt: "2026-10-08T20:45:58Z" },
];

test("two messages seconds apart are one burst: the first folds into the second, which carries both", () => {
  assert.equal(laterInBurst(thread, thread[1])?.id, "m5");
  assert.equal(laterInBurst(thread, thread[2]), null);
  assert.equal(burstText(thread, thread[2]), "Sounds great\n\nLooking forward to the session.");
});

test("a reply after one of ours, or long after the last, is its own card", () => {
  const later = [...thread, { id: "a2", direction: "outbound", body: "See you!", sentAt: "2026-10-08T21:00:00Z" }, { id: "m6", direction: "inbound", body: "Thanks", sentAt: "2026-10-08T21:01:00Z" }];
  assert.deepEqual(burstOf(later, later[4]).map((m) => m.id), ["m6"]);
  const apart = [thread[0], thread[1], { id: "m7", direction: "inbound", body: "Also, one question", sentAt: "2026-10-08T21:30:00Z" }];
  assert.equal(laterInBurst(apart, apart[1]), null, "45 minutes later is a new reply");
});

import { readFileSync } from "node:fs";

test("the alert folds a burst into its newest message and waits for the lead to go quiet", () => {
  const run = readFileSync(new URL("../app/lib/reply-alert-run.ts", import.meta.url), "utf8");
  assert.match(run, /const later = laterInBurst\(burstThread, selfInThread\);[\s\S]{0,200}skipped: "merged"/);
  assert.match(run, /latestReply: burstText\(messages, latest\)/);
  assert.match(run, /QUIET_MS - \(Date\.now\(\) - newest\)/);
});
