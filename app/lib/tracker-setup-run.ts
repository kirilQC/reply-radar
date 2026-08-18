// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Building the two tracker tables in one client base.
 *
 * The shape is in `tracker-setup.ts` and is pure. This is the order the schema writes go out in, which
 * is not the order the fields are listed: a link needs both tables, a formula needs its numbers.
 *
 * Run once per client, from a button, never on a schedule. A client base is a system other people work
 * out of every day and this is the only thing in Reply Radar that changes its structure, so it happens
 * because somebody pressed it, and it reports every single thing it did.
 */
import { createField, createTable, findTableByName, getBaseTables, type AirtableFieldSpec, type AirtableTable } from "./airtable";
import { fieldsAtStage, planSetup, type TablePlan, type TrackerFieldSpec } from "./tracker-setup";

/**
 * Airtable allows five requests a second per base and answers the sixth by locking the token out for
 * thirty. Filling in a table that is only half there is one request per column, so the gap is not
 * optional.
 */
const GAP_MS = 220;

export type TrackerSetupResult = {
  ok: boolean;
  created: string[];
  added: string[];
  skipped: string[];
  problems: string[];
};

/**
 * Creates whatever is missing and nothing else.
 *
 * Safe to press twice: the second run finds both tables and every field and reports that it did
 * nothing. That matters more than it sounds, because the failure mode of a setup button is somebody
 * pressing it again after a timeout, and a second `Campaign Tracker` in a base would split the client's
 * campaigns across two tables with no error anywhere.
 */
export async function setUpTrackers(baseId: string): Promise<TrackerSetupResult> {
  const result: TrackerSetupResult = { ok: false, created: [], added: [], skipped: [], problems: [] };
  if (!/^app[A-Za-z0-9]{14}$/.test(baseId)) {
    result.problems.push("That is not an Airtable base id.");
    return result;
  }

  const schema = await getBaseTables(baseId);
  if (!schema.ok) {
    result.problems.push(schema.error);
    return result;
  }

  const campaignTable = findTableByName(schema.data, "Campaign Tracker");
  const projectTable = findTableByName(schema.data, "Project Tracker");
  const plan = planSetup(campaignTable, projectTable);
  if (!plan.changes) {
    result.ok = true;
    result.skipped.push("Both tables were already there with every column the brief needs.");
    return result;
  }

  const campaignId = await settle(baseId, plan.campaign, campaignTable, result);
  const projectId = await settle(baseId, plan.project, projectTable, result);

  // The link is made from Project Tracker only. Airtable writes the matching field onto Campaign
  // Tracker itself, and asking for it from both sides leaves the base with two links between one pair
  // of tables and no way to tell which one anything is on.
  const links = fieldsAtStage(plan.project.missing, "link");
  if (campaignId && projectId) {
    for (const field of links) await add(baseId, projectId, "Project Tracker", { ...field, options: { linkedTableId: campaignId } }, result);
  } else if (links.length) {
    result.problems.push("The two tables are not linked, because one of them could not be built. Press this again once the problem above is fixed.");
  }

  if (campaignId) {
    for (const field of fieldsAtStage(plan.campaign.missing, "formula")) await add(baseId, campaignId, "Campaign Tracker", field, result);
  }

  result.ok = result.problems.length === 0;
  return result;
}

/** Creates the table if it is absent, or fills in its missing plain fields, and answers with its id. */
async function settle(baseId: string, plan: TablePlan, table: AirtableTable | null, result: TrackerSetupResult): Promise<string> {
  const base = fieldsAtStage(plan.missing, "base");

  if (plan.create) {
    // Only the plain fields go in the create. The other two stages have nothing to point at yet.
    const made = await createTable(baseId, plan.spec.name, plan.spec.description, base.map(strip));
    if (!made.ok) {
      result.problems.push(`${plan.spec.name} could not be created: ${made.error}`);
      return "";
    }
    result.created.push(`${plan.spec.name}, with ${base.length} columns.`);
    return String(made.data?.id ?? "");
  }

  if (!table) {
    result.problems.push(`${plan.spec.name} could not be read back.`);
    return "";
  }
  for (const field of base) await add(baseId, table.id, plan.spec.name, field, result);
  return table.id;
}

async function add(baseId: string, tableId: string, tableName: string, field: TrackerFieldSpec, result: TrackerSetupResult) {
  const spec = strip(field);
  const made = await createField(baseId, tableId, spec);
  if (made.ok) result.added.push(`${tableName}: ${spec.name}`);
  else result.problems.push(`${tableName} is still missing ${spec.name}: ${made.error}`);
  await new Promise((resolve) => setTimeout(resolve, GAP_MS));
}

/** `stage` is ours, for ordering. Sending it to Airtable is a 422 on an unrecognised key. */
function strip(field: TrackerFieldSpec): AirtableFieldSpec {
  return { name: field.name, type: field.type, ...(field.description ? { description: field.description } : {}), ...(field.options ? { options: field.options } : {}) };
}
