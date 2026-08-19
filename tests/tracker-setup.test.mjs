// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * What gets written into a client's Airtable base, and — more to the point — what does not.
 *
 * This is the only code in Reply Radar that changes the structure of somebody else's workspace, so the
 * tests that matter here are the negative ones: a base that is already set up must come back with
 * nothing to do, and a column that exists must be left exactly as it is however wrong it looks.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_TABLE_SPEC, PROJECT_TABLE_SPEC, WEEKLY_CALLS_TABLE_SPEC, fieldsAtStage, planSetup } from "../app/lib/tracker-setup.ts";
import { REQUIRED_ACTION_ITEM_FIELDS, REQUIRED_CAMPAIGN_FIELDS, REQUIRED_WEEKLY_CALL_FIELDS } from "../app/lib/airtable.ts";

const names = (fields) => fields.map((field) => field.name);

const TABLE_IDS = { "Campaign Tracker": "tblCampaign00001", "Project Tracker": "tblProject000001", "Weekly Calls": "tblWeeklyCalls01" };

const tableOf = (spec, only = () => true) => ({
  id: TABLE_IDS[spec.name],
  name: spec.name,
  fields: spec.fields.filter(only).map((field) => ({ id: `fld${field.name.replace(/\W/g, "")}`, name: field.name, type: field.type })),
});

test("the spec covers every field the writer will actually try to write", () => {
  // The audit and the writer read from `REQUIRED_*` in airtable.ts; this file builds the tables. Two
  // lists that can drift is a base that passes setup and then fails the audit, so they are tied here.
  for (const field of REQUIRED_CAMPAIGN_FIELDS) assert.ok(names(CAMPAIGN_TABLE_SPEC.fields).includes(field.name), `Campaign Tracker spec is missing ${field.name}`);
  for (const field of REQUIRED_ACTION_ITEM_FIELDS) assert.ok(names(PROJECT_TABLE_SPEC.fields).includes(field.name), `Project Tracker spec is missing ${field.name}`);
  for (const field of REQUIRED_WEEKLY_CALL_FIELDS) assert.ok(names(WEEKLY_CALLS_TABLE_SPEC.fields).includes(field.name), `Weekly Calls spec is missing ${field.name}`);
});

test("a base with all three tables fully built has nothing to do", () => {
  // The second press of the button. Getting this wrong gives a client two Campaign Trackers and splits
  // their campaigns across both with no error anywhere.
  const plan = planSetup(tableOf(CAMPAIGN_TABLE_SPEC), tableOf(PROJECT_TABLE_SPEC), tableOf(WEEKLY_CALLS_TABLE_SPEC));
  assert.equal(plan.changes, 0);
  assert.equal(plan.campaign.create, false);
  assert.equal(plan.project.create, false);
  assert.equal(plan.weeklyCalls.create, false);
  assert.deepEqual(plan.campaign.missing, []);
  assert.deepEqual(plan.project.missing, []);
  assert.deepEqual(plan.weeklyCalls.missing, []);
});

test("an empty base is planned as three whole tables", () => {
  const plan = planSetup(null, null, null);
  assert.equal(plan.campaign.create, true);
  assert.equal(plan.project.create, true);
  assert.equal(plan.weeklyCalls.create, true);
  assert.deepEqual(plan.campaign.missing, CAMPAIGN_TABLE_SPEC.fields);
  assert.deepEqual(plan.project.missing, PROJECT_TABLE_SPEC.fields);
  assert.deepEqual(plan.weeklyCalls.missing, WEEKLY_CALLS_TABLE_SPEC.fields);
});

test("a base with the two old tables but no Weekly Calls is planned the third table only", () => {
  // The upgrade path for an existing client: the campaign and project tables are already there, and the
  // one thing to add is the calls table, created whole.
  const plan = planSetup(tableOf(CAMPAIGN_TABLE_SPEC), tableOf(PROJECT_TABLE_SPEC), null);
  assert.equal(plan.campaign.create, false);
  assert.equal(plan.project.create, false);
  assert.equal(plan.weeklyCalls.create, true);
  // The one new table, counted as its create plus each field it will be built with.
  assert.equal(plan.changes, 1 + WEEKLY_CALLS_TABLE_SPEC.fields.length);
});

test("a half-built table is topped up rather than replaced", () => {
  const partial = tableOf(CAMPAIGN_TABLE_SPEC, (field) => field.name !== "Days Left" && field.name !== "Senders");
  const plan = planSetup(partial, tableOf(PROJECT_TABLE_SPEC), tableOf(WEEKLY_CALLS_TABLE_SPEC));
  assert.equal(plan.campaign.create, false);
  assert.deepEqual(names(plan.campaign.missing), ["Days Left", "Senders"]);
  assert.equal(plan.changes, 2);
});

test("a column that exists is left alone even when its type is wrong", () => {
  /*
   * Somebody's `Leads Sent` typed as text is a column they have already filled in. Retyping it under
   * them would empty it, and the writer is built to cope with what it finds — the audit reports the
   * mistype separately, which is a person's decision to make.
   */
  const odd = tableOf(CAMPAIGN_TABLE_SPEC);
  odd.fields = odd.fields.map((field) => (field.name === "Leads Sent" ? { ...field, type: "singleLineText" } : field));
  const plan = planSetup(odd, tableOf(PROJECT_TABLE_SPEC), tableOf(WEEKLY_CALLS_TABLE_SPEC));
  assert.equal(plan.changes, 0);
});

test("a column matches whatever the base's spacing and capitals are", () => {
  const shouty = tableOf(PROJECT_TABLE_SPEC);
  shouty.fields = shouty.fields.map((field) => (field.name === "Brief Key" ? { ...field, name: "  brief   KEY " } : field));
  const plan = planSetup(tableOf(CAMPAIGN_TABLE_SPEC), shouty, tableOf(WEEKLY_CALLS_TABLE_SPEC));
  assert.equal(plan.changes, 0);
});

test("the link and the formulas are held back to their own stages", () => {
  /*
   * Airtable cannot make these with the table: a link needs the table it points at to exist, and a
   * formula needs the fields it references. Creating them in the first request is a 422 that leaves
   * half a base behind.
   */
  assert.deepEqual(names(fieldsAtStage(PROJECT_TABLE_SPEC.fields, "link")), ["Campaign"]);
  assert.deepEqual(names(fieldsAtStage(CAMPAIGN_TABLE_SPEC.fields, "formula")), ["Acceptance Rate %", "Reply Rate %"]);
  // And the campaign side carries no link of its own: Airtable writes the other half of the pair, and
  // asking from both sides leaves two links between one pair of tables.
  assert.deepEqual(fieldsAtStage(CAMPAIGN_TABLE_SPEC.fields, "link"), []);
});

test("the rate formulas are percentages, because a ratio on a whole number field renders as zero", () => {
  const rates = fieldsAtStage(CAMPAIGN_TABLE_SPEC.fields, "formula");
  for (const rate of rates) {
    assert.match(rate.options.formula, /\* 100/, `${rate.name} is a ratio, so six percent will show as 0`);
    assert.match(rate.options.formula, /BLANK\(\)/, `${rate.name} divides by a figure that can be zero`);
  }
  // Reply rate is against accepted, not sent: you cannot reply to somebody who never connected.
  assert.match(rates[1].options.formula, /\{Replies\} \/ \{Accepted\}/);
});

test("every formula only references fields the spec actually creates", () => {
  // A formula naming a column that is not there is a field Airtable refuses, and the refusal arrives
  // after the tables are built, so the base is left one column short of usable.
  const made = new Set(names(CAMPAIGN_TABLE_SPEC.fields));
  for (const field of fieldsAtStage(CAMPAIGN_TABLE_SPEC.fields, "formula")) {
    for (const [, reference] of field.options.formula.matchAll(/\{([^}]+)\}/g)) {
      assert.ok(made.has(reference), `${field.name} references ${reference}, which nothing creates`);
    }
  }
});

test("the first field of each table can be a primary field", () => {
  // Airtable takes the first field as the primary and refuses several types for it, including checkbox
  // and every computed type. All three tables lead with the title, which is also what the gallery shows.
  for (const spec of [CAMPAIGN_TABLE_SPEC, PROJECT_TABLE_SPEC, WEEKLY_CALLS_TABLE_SPEC]) {
    assert.equal(spec.fields[0].name, "Title");
    assert.equal(spec.fields[0].type, "singleLineText");
    assert.equal(spec.fields[0].stage, "base");
  }
});

test("the Weekly Calls table is standalone: every field is a base-stage field", () => {
  // A recap is a record of one meeting, not a thing the brief moves through states, so there is no link
  // and no formula to hold back to a later stage. All of it can be made in the create.
  for (const field of WEEKLY_CALLS_TABLE_SPEC.fields) assert.equal(field.stage, "base", `${field.name} is not a base field`);
  assert.deepEqual(fieldsAtStage(WEEKLY_CALLS_TABLE_SPEC.fields, "link"), []);
  assert.deepEqual(fieldsAtStage(WEEKLY_CALLS_TABLE_SPEC.fields, "formula"), []);
});

test("the calls table carries a plain multilineText Transcript column for the full transcript", () => {
  // The transcript is filed to Airtable and nowhere else, so the column the writer targets has to exist.
  const transcript = WEEKLY_CALLS_TABLE_SPEC.fields.find((field) => field.name === "Transcript");
  assert.ok(transcript, "the spec must define a Transcript column");
  assert.equal(transcript.type, "multilineText");
  assert.equal(transcript.stage, "base");
});

test("nothing the calls writer files could make Airtable invent a Posted To option", () => {
  // `typecast` is never set, so every destination the row builder writes has to already be an option here.
  const postedTo = WEEKLY_CALLS_TABLE_SPEC.fields.find((field) => field.name === "Posted To").options.choices.map((choice) => choice.name);
  for (const wanted of ["Internal", "External", "Test", "Preview"]) assert.ok(postedTo.includes(wanted), `a base built by this file cannot say ${wanted}`);
});

test("the campaign table carries the columns the timeline is drawn from", () => {
  // The timeline needs a start and an end and the top of the funnel. Launch Date is the start and Finished
  // On the end, both plain date columns; Total Leads is the list size the morning brief fills from HeyReach.
  const field = (name) => CAMPAIGN_TABLE_SPEC.fields.find((one) => one.name === name);
  assert.equal(field("Launch Date").type, "date");
  assert.equal(field("Finished On").type, "date");
  const total = field("Total Leads");
  assert.ok(total, "the spec must define a Total Leads column");
  assert.equal(total.type, "number");
  assert.equal(total.stage, "base");
});

test("the statuses the brief drives a campaign through are all in the choice set it creates", () => {
  const status = CAMPAIGN_TABLE_SPEC.fields.find((field) => field.name === "Status");
  const choices = status.options.choices.map((choice) => choice.name);
  // Not every synonym — a fresh base gets one word per state, and `resolveChoice` handles the drifted
  // ones. What must be true is that a base we built ourselves can express all four states.
  for (const wanted of ["Sent for Approval", "Launched", "On Hold", "Completed"]) {
    assert.ok(choices.includes(wanted), `a base built by this file cannot say ${wanted}`);
  }
});

test("the project statuses include the two that close a row", () => {
  // `planProjects` deletes a row immediately on Done or Cancelled. A base with no word for either can
  // only ever close an item by waiting out the five days.
  const status = PROJECT_TABLE_SPEC.fields.find((field) => field.name === "Status");
  const choices = status.options.choices.map((choice) => choice.name);
  for (const wanted of ["Done", "Cancelled"]) assert.ok(choices.includes(wanted), `nothing in this base can be marked ${wanted}`);
});

test("nothing in the spec would let Airtable invent a select option", () => {
  // `typecast` is never used anywhere in the writer, so every value it writes has to already be an
  // option here. The Source and Type sets are the ones the extraction produces.
  const source = PROJECT_TABLE_SPEC.fields.find((field) => field.name === "Source").options.choices.map((choice) => choice.name);
  const type = PROJECT_TABLE_SPEC.fields.find((field) => field.name === "Type").options.choices.map((choice) => choice.name);
  for (const wanted of ["Internal channel", "Client channel", "Call"]) assert.ok(source.includes(wanted));
  for (const wanted of ["Action Item", "Project", "Bottleneck"]) assert.ok(type.includes(wanted));
});
