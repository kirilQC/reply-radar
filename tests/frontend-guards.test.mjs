import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Source-level guards for front-end fixes that have no browser test harness. Each one pins the
// specific mistake that shipped before, so a refactor that quietly reintroduces it fails here.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("lead database drops responses for a query the user has left", () => {
  const source = read("app/database/page.tsx");
  assert.match(source, /const seq = append \? loadSeq\.current : \+\+loadSeq\.current/);
  assert.match(source, /if \(detailFor\.current !== leadId\) return;/);
  assert.match(source, /database-drawer-backdrop"[\s\S]{0,200}event\.target === event\.currentTarget/);
});

test("cold calling runs one poll loop that rests while the tab is hidden", () => {
  const source = read("app/cold-calling/[slug]/page.tsx");
  assert.equal((source.match(/setInterval\(/g) || []).length, 1);
  assert.match(source, /document\.hidden/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /timeZone: "America\/New_York"/);
});

test("Scout reports a refused request instead of reading it as an empty stream", () => {
  const source = read("app/scout/page.tsx");
  assert.match(source, /if \(!response\.ok\) \{/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*\/\/ Read before the first save effect/);
});

test("sidebar keeps the fresh client list when the cache write throws", () => {
  const source = read("app/components/AppSidebar.tsx");
  assert.match(source, /try \{ window\.localStorage\.setItem\("reply-radar-workspaces:v2"/);
});

test("Slack hub never links to an admin anchor that does not exist", () => {
  assert.doesNotMatch(read("app/slack/page.tsx"), /#ai-call-analysis/);
});
