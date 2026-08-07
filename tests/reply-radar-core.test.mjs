import test from "node:test";
import assert from "node:assert/strict";

test("event keys are deterministic for duplicate webhook deliveries", async () => {
  const source = await import("../worker/job-queue.ts");
  const a = source.eventKey({ conversationId: "c1", messageId: "m1", timestamp: "2026-08-07T12:00:00Z" });
  const b = source.eventKey({ conversationId: "c1", messageId: "m1", timestamp: "2026-08-07T12:00:00Z" });
  assert.equal(a, b);
});

test("watchdog flags stale workspaces", async () => {
  const source = await import("../worker/watchdog.ts");
  const now = Date.parse("2026-08-07T12:00:00Z");
  assert.equal(source.workspaceNeedsAlert({ workspaceId: "w1", lastWebhookReceivedAt: "2026-08-07T05:00:00Z", lastSuccessfulPollAt: "2026-08-07T05:30:00Z", quietPeriodHours: 4 }, now), true);
});
