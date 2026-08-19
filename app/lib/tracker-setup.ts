// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The two tracker tables as they should exist in every client base, and what one base is short of.
 *
 * ── Why the shape is written down rather than copied ──────────────────────────────────────────────
 * Bluevia's pair was built by hand and everything below is that pair, described. The alternative was
 * duplicating Bluevia's tables into each base, which carries Bluevia's rows and Bluevia's field ids
 * with it, and field ids are what the formulas reference — so the copy in the next base would compute
 * from Bluevia's columns or from nothing. Describing it means every base gets the same columns with
 * its own ids, and a base that is half set up gets only what it is missing.
 *
 * ── Additive, always ──────────────────────────────────────────────────────────────────────────────
 * Nothing here renames, retypes or removes anything. A base with a `Status` set that does not match
 * these choices keeps its own — `resolveChoice` in `tracker-sync.ts` is the whole reason the writer can
 * live with that, and rewriting somebody's choice set to match this file would relabel rows they are
 * reading. So a field that exists is left exactly as it is, whatever it looks like.
 *
 * ── The three stages ──────────────────────────────────────────────────────────────────────────────
 * Airtable cannot create these all at once. A link field needs the table it points at to exist, and a
 * formula needs the fields it references to exist. So each field carries the stage it can be made in,
 * and the runner works through them in order.
 */
import type { AirtableFieldSpec, AirtableTable } from "./airtable";

/** `base` can be made with the table, `link` once both tables exist, `formula` once the numbers do. */
export type FieldStage = "base" | "link" | "formula";

export type TrackerFieldSpec = AirtableFieldSpec & { stage: FieldStage };

export type TrackerTableSpec = { name: string; description: string; fields: TrackerFieldSpec[] };

const isoDate = { dateFormat: { name: "iso" } };
const localDate = { dateFormat: { name: "local" } };
const wholeNumber = { precision: 0 };

const PRIORITY_CHOICES = {
  choices: [
    { name: "Urgent", color: "redBright" },
    { name: "High", color: "orangeBright" },
    { name: "Medium", color: "yellowBright" },
    { name: "Low", color: "greenLight2" },
  ],
};

/**
 * `Owner` is text and `Assignee` is a collaborator, and that split is deliberate. The brief's owners
 * are Slack mentions, and not all of them are people — "QC Campaign Approval and Launch" is a group.
 * Guessing a collaborator from a name puts a task on whoever shares a first name.
 */
export const CAMPAIGN_TABLE_SPEC: TrackerTableSpec = {
  name: "Campaign Tracker",
  description:
    "One row per outbound campaign, matching the numbered lead tables. The morning brief moves a row through Sent for Approval, Active, Paused and Finished, and writes the final figures when it finishes. Action items live in Project Tracker.",
  fields: [
    { stage: "base", name: "Title", type: "singleLineText" },
    { stage: "base", name: "Campaign Code", type: "singleLineText", description: "BV001, W007 and so on — the code that joins this row to its lead table." },
    {
      stage: "base",
      name: "Status",
      type: "singleSelect",
      options: {
        choices: [
          { name: "Not Started", color: "blueLight2" },
          { name: "Sent for Approval", color: "purpleLight2" },
          { name: "Launched", color: "tealLight2" },
          { name: "On Hold", color: "yellowLight2" },
          { name: "Completed", color: "greenLight2" },
          { name: "Cancelled", color: "redLight2" },
        ],
      },
    },
    { stage: "base", name: "Owner", type: "singleLineText", description: "Who owns this, as a name. Set by hand or by the morning brief." },
    { stage: "base", name: "Assignee", type: "singleCollaborator", description: "The real Airtable person. Set by hand — the brief never guesses this." },
    { stage: "base", name: "Priority", type: "singleSelect", options: PRIORITY_CHOICES },
    { stage: "base", name: "Launch Date", type: "date", options: localDate },
    { stage: "base", name: "Notes", type: "multilineText" },
    { stage: "base", name: "Leads Sent", type: "number", options: wholeNumber, description: "Connection requests sent, as HeyReach reported them on the last morning brief." },
    { stage: "base", name: "Accepted", type: "number", options: wholeNumber, description: "Connection requests accepted." },
    { stage: "base", name: "Replies", type: "number", options: wholeNumber, description: "Replies received." },
    { stage: "base", name: "Pending Leads", type: "number", options: wholeNumber, description: "Leads still queued to be sent to. Zero on a live campaign is what makes it finished." },
    { stage: "base", name: "Days Left", type: "number", options: wholeNumber, description: "Days of sending left at the current rate. Blank when the sending rate is not known." },
    {
      stage: "base",
      name: "Senders",
      type: "singleLineText",
      description: "The LinkedIn accounts sending this campaign, by name. Left blank rather than filled with ids when the names are not recorded.",
    },
    { stage: "base", name: "Finished On", type: "date", options: isoDate, description: "The day the brief first saw this campaign out of leads. The figures beside it are the final ones." },
    {
      stage: "base",
      name: "Last Synced",
      type: "date",
      options: isoDate,
      description: "The last morning brief that refreshed the figures on this row. A date that stopped moving means the brief stopped finding this campaign.",
    },
    // Percentages rather than ratios: `{Accepted}/{Leads Sent}` on a number field of precision 0 shows
    // an acceptance rate of six percent as 0, which is how the first version of this read as a table
    // full of dead campaigns.
    {
      stage: "formula",
      name: "Acceptance Rate %",
      type: "formula",
      description: "Computed, not written. Accepted over sent, as a percentage to one decimal place.",
      options: { formula: "IF({Leads Sent} > 0, ROUND({Accepted} / {Leads Sent} * 100, 1), BLANK())" },
    },
    {
      stage: "formula",
      name: "Reply Rate %",
      type: "formula",
      description: "Computed, not written. Replies over accepted, as a percentage to one decimal place. Against accepted rather than sent, because you cannot reply to somebody who never connected.",
      options: { formula: "IF({Accepted} > 0, ROUND({Replies} / {Accepted} * 100, 1), BLANK())" },
    },
  ],
};

export const PROJECT_TABLE_SPEC: TrackerTableSpec = {
  name: "Project Tracker",
  description:
    "Everything that is not a campaign: projects, action items and bottlenecks. A live list of what is outstanding. The morning brief adds and updates rows it raised, and removes its own rows once they stop appearing in the brief, so this stays short enough to read in a gallery.",
  fields: [
    { stage: "base", name: "Title", type: "singleLineText" },
    {
      stage: "base",
      name: "Type",
      type: "singleSelect",
      options: {
        choices: [
          { name: "Action Item", color: "blueLight2" },
          { name: "Project", color: "cyanLight2" },
          { name: "Bottleneck", color: "orangeLight2" },
        ],
      },
    },
    {
      stage: "base",
      name: "Status",
      type: "singleSelect",
      options: {
        choices: [
          { name: "Not Started", color: "blueLight2" },
          { name: "In Progress", color: "cyanLight2" },
          { name: "Blocked", color: "redLight2" },
          { name: "Done", color: "greenLight2" },
          { name: "Cancelled", color: "grayLight2" },
        ],
      },
    },
    {
      stage: "base",
      name: "Owner",
      type: "singleLineText",
      description: "Who owes this, written exactly as the brief said it. May be several people, or a group like QC Campaign Approval and Launch.",
    },
    { stage: "base", name: "Priority", type: "singleSelect", options: PRIORITY_CHOICES },
    {
      stage: "base",
      name: "Detail",
      type: "multilineText",
      description: "The evidence the brief gave for raising this — what was said, by whom, and what has not happened since.",
    },
    {
      stage: "base",
      name: "Source",
      type: "singleSelect",
      description: "Where this was raised.",
      options: {
        choices: [
          { name: "Internal channel", color: "blueLight2" },
          { name: "Client channel", color: "cyanLight2" },
          { name: "Call", color: "tealLight2" },
          { name: "Manual", color: "grayLight2" },
        ],
      },
    },
    { stage: "base", name: "Source Link", type: "url", description: "Permalink to the Slack message or call recap this came from." },
    {
      stage: "base",
      name: "First Raised",
      type: "date",
      options: localDate,
      description: "When this was first said. What ages an item — not the date the brief noticed it.",
    },
    { stage: "base", name: "Due Date", type: "date", options: localDate },
    {
      stage: "base",
      name: "Brief Key",
      type: "singleLineText",
      description:
        "Stable id the brief uses to recognise this item again on a later run, so a re-run updates this row instead of adding a second copy. Do not edit.",
    },
    {
      stage: "base",
      name: "Last Seen",
      type: "date",
      options: localDate,
      description: "The last brief that still considered this open. Stops moving once the item drops out of the brief.",
    },
    {
      stage: "base",
      name: "Raised by Brief",
      type: "checkbox",
      options: { icon: "check", color: "greenBright" },
      description:
        "Ticked by the morning brief on rows it created. The brief will only ever update rows with this ticked — untick it to make a row permanently yours.",
    },
    { stage: "base", name: "Assignee", type: "singleCollaborator", description: "The real Airtable person. Set by hand — the brief never guesses this." },
    // Made last and from this side only. Airtable writes the other half of the pair onto Campaign
    // Tracker itself, so asking for it from both sides is how a base ends up with two link fields.
    { stage: "link", name: "Campaign", type: "multipleRecordLinks", description: "The campaign this concerns, when it concerns one." },
  ],
};

/**
 * One row per weekly call, written by the call analysis. Standalone — no link, no formula — because a
 * recap is a record of one meeting, not a thing the brief moves through states. `Call ID` is the Granola
 * note id and the reason a re-run of the same call updates its row instead of adding a second recap.
 */
export const WEEKLY_CALLS_TABLE_SPEC: TrackerTableSpec = {
  name: "Weekly Calls",
  description:
    "One row per weekly call, filed by the call analysis. Each row is a meeting: its date, who was on it, how long it ran, and the recap the model wrote. A re-run of the same call updates its row rather than adding a second, keyed on Call ID. Group a view by Call Date to read the weeks in order.",
  fields: [
    { stage: "base", name: "Title", type: "singleLineText", description: "The call, as Granola titled it." },
    { stage: "base", name: "Call Date", type: "date", options: localDate, description: "The day the call was on — not the day the recap was filed." },
    { stage: "base", name: "Attendees", type: "singleLineText", description: "Who was on the call, by name." },
    { stage: "base", name: "Host", type: "singleLineText", description: "Whose call it was." },
    { stage: "base", name: "Duration (min)", type: "number", options: wholeNumber, description: "How long the call ran, in minutes." },
    { stage: "base", name: "Recap", type: "multilineText", description: "The recap the model wrote, in plain text — the Slack formatting stripped out so it reads in a cell." },
    {
      stage: "base",
      name: "Transcript",
      type: "multilineText",
      description: "The full transcript of the call, filed here and nowhere else. Kept from the end when a call runs past Airtable's cell limit.",
    },
    {
      stage: "base",
      name: "Posted To",
      type: "singleSelect",
      description: "Where the recap went.",
      options: {
        choices: [
          { name: "Internal", color: "blueLight2" },
          { name: "External", color: "cyanLight2" },
          { name: "Test", color: "yellowLight2" },
          { name: "Preview", color: "grayLight2" },
        ],
      },
    },
    {
      stage: "base",
      name: "Call ID",
      type: "singleLineText",
      description: "The Granola note id. What lets a re-run update this row instead of adding a second copy. Do not edit.",
    },
    {
      stage: "base",
      name: "Last Synced",
      type: "date",
      options: isoDate,
      description: "The last call analysis that refreshed this row.",
    },
  ],
};

const flatten = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export type TablePlan = { spec: TrackerTableSpec; create: boolean; missing: TrackerFieldSpec[] };

export type SetupPlan = { campaign: TablePlan; project: TablePlan; weeklyCalls: TablePlan; changes: number };

/**
 * What one base is short of, decided without touching the network.
 *
 * A table that is absent is created with its `base` fields and nothing else, because the other two
 * stages cannot exist yet. A table that is present is compared field by field on name alone: the type
 * is not checked, because a column somebody has already filled in is theirs, and "wrong type" is a
 * thing to report rather than a thing to correct underneath them.
 */
export function planSetup(
  campaignTable: AirtableTable | null,
  projectTable: AirtableTable | null,
  weeklyCallsTable: AirtableTable | null,
): SetupPlan {
  const plan = (spec: TrackerTableSpec, table: AirtableTable | null): TablePlan => {
    if (!table) return { spec, create: true, missing: spec.fields };
    const have = new Set((table.fields ?? []).map((field) => flatten(field.name)));
    return { spec, create: false, missing: spec.fields.filter((field) => !have.has(flatten(field.name))) };
  };

  const campaign = plan(CAMPAIGN_TABLE_SPEC, campaignTable);
  const project = plan(PROJECT_TABLE_SPEC, projectTable);
  const weeklyCalls = plan(WEEKLY_CALLS_TABLE_SPEC, weeklyCallsTable);
  const changes =
    (campaign.create ? 1 : 0) +
    (project.create ? 1 : 0) +
    (weeklyCalls.create ? 1 : 0) +
    campaign.missing.length +
    project.missing.length +
    weeklyCalls.missing.length;
  return { campaign, project, weeklyCalls, changes };
}

/** The fields of one stage, in the order they are written down. */
export function fieldsAtStage(fields: TrackerFieldSpec[], stage: FieldStage): TrackerFieldSpec[] {
  return fields.filter((field) => field.stage === stage);
}
