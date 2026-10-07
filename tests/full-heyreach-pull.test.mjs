// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../worker/render-worker.mjs", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/admin/heyreach/full-pull/route.ts", import.meta.url), "utf8");
const fullPull = worker.slice(worker.indexOf("async function fullPull("), worker.indexOf("async function analyticsLoop("));

test("conversations are removed only when HeyReach returned the complete inbox", () => {
  assert.match(fullPull, /if \(complete && items\.length\)/);
  assert.match(worker, /return \{ items, complete: false \};/, "running out of pages is never complete");
});

test("a continuation pass never clears stats or removes conversations again", () => {
  const guarded = fullPull.match(/if \(!continuing\) \{/g) ?? [];
  assert.equal(guarded.length, 2, "both the clear-and-rebuild and the removal sit behind !continuing");
  assert.match(fullPull, /source: "admin-continue", status: "queued"/);
});

test("a lead is only deleted when none of its conversations belong to this account", () => {
  assert.match(fullPull, /leadIds\.filter\(\(lead\) => !keep\.has\(lead\)\)/);
});

test("the key is checked before a pull is queued, and only one pull runs per client", () => {
  assert.ok(route.indexOf("CheckApiKey") < route.indexOf('run_type: "full_pull"'));
  assert.match(route, /current\.status === "queued" \|\| current\.status === "running"/);
});

test("the worker claims a requested pull before routine analytics", () => {
  const loop = worker.slice(worker.indexOf("async function analyticsLoop("));
  assert.ok(loop.indexOf("claimFullPull()") < loop.indexOf("collectAnalytics()"));
});
