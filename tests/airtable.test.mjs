// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The two things that decide whether a client's action items land in the right company's tracker:
 * which base a workspace maps to, and whether that base's tracker can be written into.
 *
 * The base list here is the real one, names and all — two `Client Template 1`s, two `Untitled Base`s,
 * a `Hempmatics` beside a `Hemaptics`, and three bases starting `QC Growth`. Those collisions are the
 * entire reason this matcher refuses rather than picks, so testing against a tidied-up list would test
 * the wrong thing.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { airtableBaseFor, isConfidentMatch } from "../shared/airtable-link.mjs";
import { auditTrackerTables, findTrackerTable, REQUIRED_TRACKER_FIELDS, TRACKER_TABLE_ID } from "../app/lib/airtable.ts";

const BASES = [
  { id: "appKH5X6AO2uXTsI1", name: "KI test" },
  { id: "appYgyBwg0vnMfVHH", name: "Client Template 1" },
  { id: "appwcMa2uFc0cJlmI", name: "Client Template 1" },
  { id: "apphji94rxZohBNno", name: "Client Template" },
  { id: "app4fQrF7XLSyXptG", name: "QC Growth (Automations)" },
  { id: "appTBq7wAmLzP7K63", name: "QC Growth Internal" },
  { id: "appvVzkmabfV7s5K8", name: "QC Growth" },
  { id: "appHDmwRZZGqJ0pSN", name: "Willow" },
  { id: "appPwljHf8ozgVjMq", name: "Cotool" },
  { id: "appoVGkvrA146CmzF", name: "Bluevia Health" },
  { id: "appx6lQEFLNLxsvob", name: "Hempmatics" },
  { id: "appeUipbNEQLOcY5F", name: "Hemaptics" },
  { id: "app8tLajIyC1pWbL7", name: "Untitled Base" },
  { id: "appXjTn5IEle4mUhr", name: "Untitled Base" },
];

test("an exact name match maps a workspace to its base", () => {
  const match = airtableBaseFor({ slug: "willow", name: "Willow" }, BASES);
  assert.equal(match.baseId, "appHDmwRZZGqJ0pSN");
  assert.equal(match.how, "slug");
  assert.ok(isConfidentMatch(match.how));
});

test("the slug matches even when the display name has drifted", () => {
  const match = airtableBaseFor({ slug: "cotool", name: "Cotool (Q3)" }, BASES);
  assert.equal(match.baseId, "appPwljHf8ozgVjMq");
  assert.equal(match.how, "slug");
});

test("punctuation and spacing do not stop a match", () => {
  const match = airtableBaseFor({ slug: "bluevia-health", name: "Bluevia Health" }, BASES);
  assert.equal(match.baseId, "appoVGkvrA146CmzF");
  assert.ok(isConfidentMatch(match.how));
});

test("a stored choice wins over any guess, and survives the base being renamed", () => {
  // The workspace is called Willow and would otherwise match the Willow base. Somebody said otherwise.
  const match = airtableBaseFor({ slug: "willow", name: "Willow", airtableBaseId: "appPwljHf8ozgVjMq" }, BASES);
  assert.equal(match.baseId, "appPwljHf8ozgVjMq");
  assert.equal(match.how, "chosen");
});

test("a stored id the token can no longer see is still returned, not silently re-guessed", () => {
  // Re-guessing here would quietly move a client's writes to a different base the morning the token's
  // access changed, which is exactly the failure nobody would think to look for.
  const match = airtableBaseFor({ slug: "willow", name: "Willow", airtableBaseId: "appGONEGONEGONE01" }, BASES);
  assert.equal(match.baseId, "appGONEGONEGONE01");
  assert.equal(match.how, "chosen");
  assert.equal(match.name, "");
});

test("two bases with the same name are ambiguous, not a coin toss", () => {
  const match = airtableBaseFor({ slug: "client-template-1", name: "Client Template 1" }, BASES);
  assert.equal(match.how, "ambiguous");
  assert.equal(match.baseId, "");
  assert.equal(match.candidates.length, 2);
  assert.ok(!isConfidentMatch(match.how));
});

test("a name that loosely contains three bases is ambiguous rather than the first of them", () => {
  const match = airtableBaseFor({ slug: "qc-growth", name: "QC Growth" }, BASES);
  // `QC Growth` matches its own base exactly, so the exact rung settles it before containment runs.
  assert.equal(match.baseId, "appvVzkmabfV7s5K8");
  assert.equal(match.how, "slug");
});

test("containment that spans several bases refuses instead of picking", () => {
  // Contains both `QC Growth` and `QC Growth Internal`. Taking the first would be taking whichever
  // order Airtable happened to list them in.
  const match = airtableBaseFor({ slug: "qc-growth-internal-ops", name: "QC Growth Internal Ops" }, BASES);
  assert.equal(match.how, "ambiguous");
  assert.equal(match.baseId, "");
  assert.ok(match.candidates.length >= 2);
});

test("containment onto exactly one base is a single loose match, not a refusal", () => {
  const match = airtableBaseFor({ slug: "qc-growth-team", name: "QC Growth Team" }, BASES);
  assert.equal(match.baseId, "appvVzkmabfV7s5K8");
  assert.equal(match.how, "loose");
});

test("a loose match is returned but is not confident enough to write through", () => {
  const match = airtableBaseFor({ slug: "hempmatics-labs", name: "Hempmatics Labs" }, BASES);
  assert.equal(match.baseId, "appx6lQEFLNLxsvob");
  assert.equal(match.how, "loose");
  assert.ok(!isConfidentMatch(match.how), "a one-keystroke neighbour like Hemaptics is why loose is not enough");
});

test("a workspace matching nothing returns nothing rather than the nearest base", () => {
  const match = airtableBaseFor({ slug: "acme-robotics", name: "Acme Robotics" }, BASES);
  assert.equal(match.baseId, "");
  assert.equal(match.how, "");
});

test("a nameless workspace does not match every short base name", () => {
  const match = airtableBaseFor({ slug: "", name: "" }, BASES);
  assert.equal(match.baseId, "");
  assert.equal(match.how, "");
});

/* ── The tracker audit ──────────────────────────────────────────────────────────────────────────── */

const field = (id, name, type, choices) => ({ id, name, type, ...(choices ? { options: { choices: choices.map((choice, index) => ({ id: `sel${index}`, name: choice })) } } : {}) });

/** The tracker as it really is in a client base, with the fields the brief needs. */
const readyTracker = () => ({
  id: TRACKER_TABLE_ID,
  name: "Campaigns & Projects Tracker",
  fields: [
    field("fld8fhitNz1pb8gFb", "Title", "singleLineText"),
    field("fld6x01xAKokE1w4F", "Status", "singleSelect", ["Not Started", "In Progress", "Done"]),
    field("fld8qDqEdu6PDONPA", "Type", "singleSelect", ["Campaign", "Project", "To Do"]),
    field("fldYXz69102YCuZii", "Assignee", "singleCollaborator"),
    field("fldVIbKtOuLim0zTW", "Comments", "multilineText"),
    field("fldgtxOE2vK7vZQHp", "Due Date", "date"),
  ],
});

test("the tracker is found by its shared table id even when renamed", () => {
  const table = findTrackerTable([{ id: "tblOther", name: "Master Table" }, { ...readyTracker(), name: "Renamed Entirely" }]);
  assert.equal(table.id, TRACKER_TABLE_ID);
});

test("the tracker is found by name in a base that was built rather than duplicated", () => {
  const table = findTrackerTable([{ id: "tblFresh0000000001", name: "Campaigns & Projects", fields: [] }]);
  assert.equal(table.id, "tblFresh0000000001");
});

test("a ready tracker reports ready, with the real choice sets", () => {
  const audit = auditTrackerTables("appHDmwRZZGqJ0pSN", [readyTracker()]);
  assert.equal(audit.ready, true);
  assert.equal(audit.table.matchedBy, "id");
  assert.equal(audit.missing.length, 0);
  assert.equal(audit.mistyped.length, 0);
  assert.deepEqual(audit.typeChoices, ["Campaign", "Project", "To Do"]);
});

test("a base with no tracker at all is reported as such, not as a tracker missing every field", () => {
  const audit = auditTrackerTables("appoPRY555McadjfR", [{ id: "tblLeads0000000001", name: "Master Lead Database", fields: [] }]);
  assert.equal(audit.ready, false);
  assert.equal(audit.table, null);
  assert.equal(audit.missing.length, REQUIRED_TRACKER_FIELDS.length);
});

test("a missing field is named so somebody can add it", () => {
  const table = readyTracker();
  table.fields = table.fields.filter((entry) => entry.name !== "Due Date");
  const audit = auditTrackerTables("appHDmwRZZGqJ0pSN", [table]);
  assert.equal(audit.ready, false);
  assert.deepEqual(audit.missing.map((entry) => entry.name), ["Due Date"]);
});

test("a field of the wrong type is a fault, not a pass", () => {
  // The failure this catches: Assignee left as text reads as present, and every write of a
  // collaborator object into it would be rejected one morning at a time.
  const table = readyTracker();
  table.fields = table.fields.map((entry) => (entry.name === "Assignee" ? field(entry.id, "Assignee", "singleLineText") : entry));
  const audit = auditTrackerTables("appHDmwRZZGqJ0pSN", [table]);
  assert.equal(audit.ready, false);
  assert.deepEqual(audit.mistyped, [{ name: "Assignee", id: "fldYXz69102YCuZii", expected: "singleCollaborator", actual: "singleLineText" }]);
});

test("field names are matched case and space insensitively", () => {
  const table = readyTracker();
  table.fields = table.fields.map((entry) => (entry.name === "Due Date" ? field(entry.id, " due date ", "date") : entry));
  const audit = auditTrackerTables("appHDmwRZZGqJ0pSN", [table]);
  assert.equal(audit.ready, true);
});

test("the required set holds no field whose id drifts between client bases", () => {
  // Responsibility has three different ids across four bases and Cotool's means something else
  // entirely; Priority is absent from the template. Neither may become a required field by accident.
  const names = REQUIRED_TRACKER_FIELDS.map((entry) => entry.name);
  assert.ok(!names.includes("Responsibility"));
  assert.ok(!names.includes("Priority"));
});

test("the writer never sets typecast, so it cannot invent options in a client's base", () => {
  // Comments are stripped first: the file explains at length why typecast is never set, and a scan
  // that trips over its own explanation would be turned off rather than obeyed.
  const source = readFileSync(new URL("../app/lib/airtable.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/typecast/.test(code), "typecast must not appear in the code at all, at any value");
});

test("the migration and the schema both carry the mapping column", () => {
  const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/migrations/20260818_airtable_base_mapping.sql", import.meta.url), "utf8");
  assert.ok(schema.includes("airtable_base_id"));
  assert.ok(migration.includes("add column if not exists airtable_base_id"));
});

test("the admin route refuses a base id that is not one", () => {
  const route = readFileSync(new URL("../app/api/admin/workspaces/route.ts", import.meta.url), "utf8");
  assert.ok(route.includes("airtableBaseId"));
  assert.ok(/\^app\[A-Za-z0-9\]\{14\}\$/.test(route), "a half-pasted id must not be storable");
});
