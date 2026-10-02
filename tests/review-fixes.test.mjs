// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Regression tests for a batch of review fixes, each one a case where the code used to do something
 * destructive or misleading quietly: an empty extraction that wiped a tracker, a Done row flipped back
 * open, a spreadsheet cell that ran as a formula.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractTrackerItems, parseTrackerItems, parseTrackerReply } from "../app/lib/tracker-extract.ts";
import { isClosedStatus, planProjects } from "../app/lib/tracker-sync.ts";
import { answerToCsv, csvField, defuseFormula, rowsToCsv } from "../shared/answer-export.mjs";

const signals = { campaigns: { names: [] } };
const CHOICES = {
  status: ["Not Started", "In Progress", "Blocked", "Done", "Cancelled"],
  type: ["Action Item", "Project", "Bottleneck"],
  source: ["Internal channel", "Client channel", "Call", "Manual"],
  priority: ["Urgent", "High", "Medium", "Low"],
};
const item = (over = {}) => ({
  title: "Chase the surgeon list",
  type: "Action Item",
  status: "In Progress",
  priority: "Medium",
  owner: "",
  detail: "",
  source: "Internal channel",
  campaignCode: "",
  key: "surgeon-list",
  ...over,
});

/** Runs the extraction against a canned Anthropic reply, with no network. */
async function extractWith(reply) {
  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-key";
  globalThis.fetch = async () => new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
  try {
    return await extractTrackerItems("the brief", signals);
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }
}

/* ── Tracker extraction ─────────────────────────────────────────────────────────────────────────── */

test("a reply cut off by the token limit is an error, not an empty board", async () => {
  const result = await extractWith({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"items":[{"title":"A","key":"a"},{"tit' }] });
  assert.deepEqual(result.items, []);
  assert.ok(result.error, "the caller only protects the tracker when an error is set");
});

test("a reply that is not JSON is an error, not an empty board", async () => {
  const result = await extractWith({ stop_reason: "end_turn", content: [{ type: "text", text: "I could not find any action items." }] });
  assert.ok(result.error);
});

test("a genuinely empty list is still an empty list with no error", async () => {
  const result = await extractWith({ stop_reason: "end_turn", content: [{ type: "text", text: '{"items":[]}' }] });
  assert.deepEqual(result, { items: [], error: "" });
});

test("parseTrackerReply tells unreadable from empty; parseTrackerItems keeps its old contract", () => {
  assert.equal(parseTrackerReply("not json"), null);
  assert.equal(parseTrackerReply('{"rows":[]}'), null);
  assert.deepEqual(parseTrackerReply('{"items":[]}'), []);
  assert.deepEqual(parseTrackerItems("not json"), []);
});

/* ── Tracker sync ───────────────────────────────────────────────────────────────────────────────── */

test("a row a person closed keeps its status when the brief raises it again", () => {
  for (const status of ["Done", { name: "Cancelled" }, "completed"]) {
    const rows = [{ id: "rec1", fields: { "Brief Key": "surgeon-list", "Raised by Brief": true, Status: status, "Last Seen": "2026-08-14" } }];
    const plan = planProjects([item()], rows, CHOICES, new Map(), "2026-08-18");
    assert.equal(plan.updates[0].id, "rec1");
    assert.equal("Status" in plan.updates[0].fields, false, `a ${JSON.stringify(status)} row was reopened`);
    assert.equal(plan.updates[0].fields["Last Seen"], "2026-08-18", "the rest of the row still updates");
  }
});

test("an open row still takes the brief's status", () => {
  const rows = [{ id: "rec1", fields: { "Brief Key": "surgeon-list", "Raised by Brief": true, Status: "Not Started" } }];
  const plan = planProjects([item()], rows, CHOICES, new Map(), "2026-08-18");
  assert.equal(plan.updates[0].fields.Status, "In Progress");
});

test("isClosedStatus reads both a name and Airtable's select object", () => {
  assert.equal(isClosedStatus("Done"), true);
  assert.equal(isClosedStatus({ name: "Canceled" }), true);
  assert.equal(isClosedStatus("In Progress"), false);
  assert.equal(isClosedStatus(null), false);
});

/* ── CSV exports ────────────────────────────────────────────────────────────────────────────────── */

test("a cell a spreadsheet would run as a formula is defused", () => {
  assert.equal(csvField('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  assert.equal(csvField("+1 call me"), "'+1 call me");
  assert.equal(csvField("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvField("-2+3"), "'-2+3");
  assert.equal(defuseFormula("\tcmd"), "'\tcmd");
});

test("plain numbers, including negative ones, are left as numbers", () => {
  assert.equal(csvField("-12"), "-12");
  assert.equal(csvField("+3.5%"), "+3.5%");
  assert.equal(csvField(-4), "-4");
  assert.equal(csvField("CT001"), "CT001");
});

test("a carriage return is quoted so it cannot split the row", () => {
  assert.equal(csvField("a\rb"), '"a\rb"');
});

test("exports start with a byte-order mark so Excel reads UTF-8", () => {
  assert.ok(rowsToCsv(["Name"], [["Zoë"]]).startsWith("﻿"));
  assert.ok(answerToCsv({ question: "q", answer: "a" }).startsWith("﻿"));
});

/* ── Source-level guards for modules that cannot be imported without their runtime ───────────────── */

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the DNC removal no longer deletes on a partial match", () => {
  const dnc = read("../app/lib/dnc.ts");
  const removal = dnc.slice(dnc.indexOf("export async function removeFromDnc"));
  assert.doesNotMatch(removal, /ilike\.\*/, "a wildcard filter is back in the delete");
  assert.match(removal, /candidates/, "partial matches are returned for the caller to choose from");
});

test("the Granola heartbeat does not treat a failed read as nothing posted", () => {
  const route = read("../app/api/granola/heartbeat/route.ts");
  assert.doesNotMatch(route, /call_analysis[^\n]*\.catch\(\(\) => \[\]\)/);
});
