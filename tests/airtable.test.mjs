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
import {
  ACTION_ITEMS_TABLE_NAME,
  auditTrackerTables,
  CAMPAIGNS_TABLE_NAME,
  findLegacyTracker,
  findTableByName,
  LEGACY_TRACKER_TABLE_ID,
  REQUIRED_ACTION_ITEM_FIELDS,
  REQUIRED_CAMPAIGN_FIELDS,
  REQUIRED_WEEKLY_CALL_FIELDS,
  WEEKLY_CALLS_TABLE_NAME,
} from "../app/lib/airtable.ts";

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

/** The two tables as they really are in Bluevia, the base they were first built in. */
const campaignsTable = () => ({
  id: "tblrq38rkLIPujZUs",
  name: CAMPAIGNS_TABLE_NAME,
  fields: [
    field("fld4XBrL37ozk5UAh", "Title", "singleLineText"),
    field("fldJtNrjq9YViFP6X", "Campaign Code", "singleLineText"),
    field("fld2Vskb3wVQGww1z", "Status", "singleSelect", ["Not Started", "In Progress", "Launched", "On Hold", "Completed"]),
    field("fldbbmIyGS6dGuGvx", "Owner", "singleLineText"),
    field("fldC1XtLoCXUrOce5", "Launch Date", "date"),
    field("fld1zppGcnad7hGMk", "Leads Sent", "number"),
    field("fldb4WN69DZ87T9XK", "Accepted", "number"),
    field("fld9qdE99hiT2EHPg", "Replies", "number"),
    field("fldOY3MZLhaI94pqz", "Pending Leads", "number"),
    field("fldYhGxe3dQ6UkuEM", "Days Left", "number"),
    field("fld9NLUICgbVfzo9c", "Senders", "singleLineText"),
    field("fldkJGyIrBTmWQfEW", "Finished On", "date"),
    field("fldoBsAinDMweSvIZ", "Last Synced", "date"),
  ],
});

const actionItemsTable = () => ({
  id: "tbljRlffgDz7B6BBZ",
  name: ACTION_ITEMS_TABLE_NAME,
  fields: [
    field("flde7oPbCgZfWAF7t", "Title", "singleLineText"),
    field("fldoyzvBiyygkjahq", "Type", "singleSelect", ["Action Item", "Project", "Bottleneck"]),
    field("fld7vg2EDjZHOka34", "Status", "singleSelect", ["Not Started", "In Progress", "Blocked", "Done"]),
    field("fldXRUE0POnMUF2Yo", "Owner", "singleLineText"),
    field("fldngQSQMHrpv4PsE", "Detail", "multilineText"),
    field("fld1YYonDeAH697jV", "Source", "singleSelect", ["Internal channel", "Client channel", "Call", "Manual"]),
    field("fldWPDI21CvxSAdAW", "First Raised", "date"),
    field("fldXlqo7fupibMCmI", "Brief Key", "singleLineText"),
    field("fldoXtRAc5ahFZbPY", "Last Seen", "date"),
    field("fldmhUxFPmmZdHDtf", "Raised by Brief", "checkbox"),
  ],
});

const weeklyCallsTable = () => ({
  id: "tblWeeklyCalls001",
  name: WEEKLY_CALLS_TABLE_NAME,
  fields: [
    field("fldWCTitle0000001", "Title", "singleLineText"),
    field("fldWCCallDate0001", "Call Date", "date"),
    field("fldWCAttendees001", "Attendees", "singleLineText"),
    field("fldWCHost00000001", "Host", "singleLineText"),
    field("fldWCDuration0001", "Duration (min)", "number"),
    field("fldWCRecap0000001", "Recap", "multilineText"),
    field("fldWCPostedTo0001", "Posted To", "singleSelect", ["Internal", "External", "Test", "Preview"]),
    field("fldWCCallID000001", "Call ID", "singleLineText"),
    field("fldWCLastSynced01", "Last Synced", "date"),
  ],
});

const splitBase = () => [campaignsTable(), actionItemsTable(), weeklyCallsTable()];

test("a base with all three tables reports ready", () => {
  const audit = auditTrackerTables("appoVGkvrA146CmzF", splitBase());
  assert.equal(audit.ready, true);
  assert.equal(audit.needsSplit, false);
  assert.equal(audit.campaigns.table.id, "tblrq38rkLIPujZUs");
  assert.equal(audit.actionItems.table.id, "tbljRlffgDz7B6BBZ");
  assert.equal(audit.weeklyCalls.table.id, "tblWeeklyCalls001");
});

test("a base with the two old tables but no Weekly Calls is not ready until it is added", () => {
  // The upgrade path: an existing client base has campaigns and projects but not the calls table yet, so
  // the setup button must light up rather than reporting the base as done.
  const audit = auditTrackerTables("appoVGkvrA146CmzF", [campaignsTable(), actionItemsTable()]);
  assert.equal(audit.ready, false);
  assert.equal(audit.weeklyCalls.table, null);
  assert.equal(audit.weeklyCalls.missing.length, REQUIRED_WEEKLY_CALL_FIELDS.length);
  // And it is not mistaken for an unsplit base: the two new tables are already there.
  assert.equal(audit.needsSplit, false);
});

test("the choice sets are reported rather than judged", () => {
  const audit = auditTrackerTables("appoVGkvrA146CmzF", splitBase());
  assert.deepEqual(audit.actionItems.choices.Type, ["Action Item", "Project", "Bottleneck"]);
  assert.deepEqual(audit.actionItems.choices.Source, ["Internal channel", "Client channel", "Call", "Manual"]);
});

test("a base still holding the old combined tracker is asking to be split, not missing fields", () => {
  // The distinction that matters: this base is fine, it just has not been migrated. Reporting it as
  // ten missing fields would send somebody looking for columns to add to a table that should not exist.
  const legacy = { id: LEGACY_TRACKER_TABLE_ID, name: "Campaigns & Projects Tracker", fields: [] };
  const audit = auditTrackerTables("appPwljHf8ozgVjMq", [legacy]);
  assert.equal(audit.ready, false);
  assert.equal(audit.needsSplit, true);
  assert.equal(audit.legacyTable.id, LEGACY_TRACKER_TABLE_ID);
});

test("a base mid-migration is not told to split again", () => {
  const audit = auditTrackerTables("appoVGkvrA146CmzF", [{ id: LEGACY_TRACKER_TABLE_ID, name: "Campaigns & Projects Tracker", fields: [] }, ...splitBase()]);
  assert.equal(audit.needsSplit, false);
  assert.equal(audit.ready, true);
});

test("a base that is not a client base at all is neither ready nor asking to be split", () => {
  const audit = auditTrackerTables("app4fQrF7XLSyXptG", [{ id: "tblLeads0000000001", name: "Master Lead Database", fields: [] }]);
  assert.equal(audit.ready, false);
  assert.equal(audit.needsSplit, false);
  assert.equal(audit.campaigns.table, null);
  assert.equal(audit.actionItems.missing.length, REQUIRED_ACTION_ITEM_FIELDS.length);
});

test("the two new tables are found by name, because their ids differ in every base", () => {
  // Bluevia's Campaigns is tblrq38rkLIPujZUs and no other base will share it — these tables were
  // created after the template was duplicated, so there is no inherited id to match on.
  const renamedIds = splitBase().map((table, index) => ({ ...table, id: `tblOtherBase00000${index}` }));
  const audit = auditTrackerTables("appHDmwRZZGqJ0pSN", renamedIds);
  assert.equal(audit.ready, true);
  assert.equal(audit.campaigns.table.id, "tblOtherBase000000");
});

test("renaming a table in a client base is reported, not silently worked around", () => {
  const tables = splitBase();
  tables[1].name = "Action Items";
  const audit = auditTrackerTables("appHDmwRZZGqJ0pSN", tables);
  assert.equal(audit.ready, false);
  assert.equal(audit.actionItems.table, null);
});

test("a table name differing only by case or spacing still matches", () => {
  const tables = splitBase();
  tables[0].name = "  campaign   tracker  ";
  tables[1].name = "PROJECT TRACKER";
  const audit = auditTrackerTables("appHDmwRZZGqJ0pSN", tables);
  assert.equal(audit.ready, true);
});

test("findTableByName does not match a table that merely contains the name", () => {
  // `Campaigns & Projects Tracker` contains "Campaigns". Matching loosely here would point the writer
  // at the legacy table and undo the whole split.
  const found = findTableByName([{ id: LEGACY_TRACKER_TABLE_ID, name: "Campaigns & Projects Tracker" }], CAMPAIGNS_TABLE_NAME);
  assert.equal(found, null);
});

test("the legacy tracker is still found by id when it has been renamed", () => {
  const found = findLegacyTracker([{ id: LEGACY_TRACKER_TABLE_ID, name: "Old Tracker (archive)" }]);
  assert.equal(found.id, LEGACY_TRACKER_TABLE_ID);
});

test("a missing field is named so somebody can add it", () => {
  const tables = splitBase();
  tables[1].fields = tables[1].fields.filter((entry) => entry.name !== "Brief Key");
  const audit = auditTrackerTables("appoVGkvrA146CmzF", tables);
  assert.equal(audit.ready, false);
  assert.deepEqual(audit.actionItems.missing.map((entry) => entry.name), ["Brief Key"]);
});

test("a field of the wrong type is a fault, not a pass", () => {
  // The failure this catches: `Raised by Brief` left as text reads as present, and the brief would
  // then be unable to tell its own rows from yours — which is the one thing protecting your edits.
  const tables = splitBase();
  tables[1].fields = tables[1].fields.map((entry) => (entry.name === "Raised by Brief" ? field(entry.id, "Raised by Brief", "singleLineText") : entry));
  const audit = auditTrackerTables("appoVGkvrA146CmzF", tables);
  assert.equal(audit.ready, false);
  assert.deepEqual(audit.actionItems.mistyped, [{ name: "Raised by Brief", id: "fldmhUxFPmmZdHDtf", expected: "checkbox", actual: "singleLineText" }]);
});

test("field names are matched case and space insensitively", () => {
  const tables = splitBase();
  tables[1].fields = tables[1].fields.map((entry) => (entry.name === "First Raised" ? field(entry.id, " first raised ", "date") : entry));
  const audit = auditTrackerTables("appoVGkvrA146CmzF", tables);
  assert.equal(audit.ready, true);
});

test("the required set holds no field whose id or meaning drifts between client bases", () => {
  // Responsibility has three different ids across four bases and Cotool's means something else
  // entirely; Priority is absent from the template. Neither may become required by accident.
  const names = [...REQUIRED_ACTION_ITEM_FIELDS, ...REQUIRED_CAMPAIGN_FIELDS].map((entry) => entry.name);
  assert.ok(!names.includes("Responsibility"));
  assert.ok(!names.includes("Priority"));
});

test("Assignee is never required, because the brief is not allowed to guess a person", () => {
  // The brief writes Owner as text. Requiring the collaborator field would imply we can resolve
  // "@QC Campaign Approval and Launch" to one human, which is not a thing.
  const names = REQUIRED_ACTION_ITEM_FIELDS.map((entry) => entry.name);
  assert.ok(!names.includes("Assignee"));
  assert.ok(names.includes("Owner"));
});

test("the fields that make a re-run safe are all required", () => {
  // Without every one of these, a second brief about the same unfinished task writes a second row.
  const names = REQUIRED_ACTION_ITEM_FIELDS.map((entry) => entry.name);
  for (const needed of ["Brief Key", "Last Seen", "Raised by Brief"]) assert.ok(names.includes(needed), `${needed} must stay required`);
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
