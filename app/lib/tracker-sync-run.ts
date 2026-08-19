// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The half of the tracker sync that touches Airtable.
 *
 * The rules live in `tracker-sync.ts` and are pure, so they can be tested without a base. This file is
 * the order the requests go out in and the accounting of what came back — read that one first.
 *
 * ── Read, then decide, then write ─────────────────────────────────────────────────────────────────
 * `readTrackers` is deliberately a step of its own rather than the first few lines of `syncTrackers`,
 * because what is already on the board is needed *before* the brief is read for items — the extraction
 * is shown the existing rows so that an item already there comes back under the key it is filed under
 * rather than a fresh one. Reading afterwards is what filed a client's whole board twice.
 */
import {
  ACTION_ITEMS_TABLE_NAME,
  CAMPAIGNS_TABLE_NAME,
  choicesFor,
  createRecords,
  deleteRecords,
  findTableByName,
  getBaseTables,
  listRecords,
  updateRecords,
  type AirtableRecord,
  type AirtableTable,
} from "./airtable";
import type { BriefCampaign } from "./morning-brief";
import type { TrackerItem } from "./tracker-extract";
import { campaignCode, onlyKnownColumns, planCampaigns, planProjects, type TrackerSyncResult } from "./tracker-sync";

const blank = (): TrackerSyncResult => ({
  ran: false,
  campaigns: { created: 0, updated: 0, finished: [] },
  projects: { created: 0, updated: 0, removed: 0 },
  notes: [],
});

/**
 * Reads both tables, works out the two plans, writes them.
 *
 * Never throws and never reports a failure as success. It runs after the brief has been posted, so
 * nothing that happens here should be able to turn a delivered brief into a failed run — but a sync
 * that quietly did nothing is the thing that would let the trackers rot unnoticed, so every reason it
 * stopped comes back in `notes` and lands in the trace beside the brief.
 */
export type TrackerBoard = {
  campaignTable: AirtableTable;
  projectTable: AirtableTable;
  campaignRows: AirtableRecord[];
  projectRows: AirtableRecord[];
};

/**
 * Both tracker tables and everything currently in them.
 *
 * The only place the trackers are read. `board` is null whenever anything stopped it, with the reason
 * in `notes` — the caller passes the whole answer to `syncTrackers`, which reports the reason rather
 * than repeating the work and failing the same way a second time.
 */
export async function readTrackers(baseId: string): Promise<{ board: TrackerBoard | null; notes: string[] }> {
  if (!baseId) return { board: null, notes: ["No Airtable base is mapped to this client."] };

  const schema = await getBaseTables(baseId);
  if (!schema.ok) return { board: null, notes: [schema.error] };
  const campaignTable = findTableByName(schema.data, CAMPAIGNS_TABLE_NAME);
  const projectTable = findTableByName(schema.data, ACTION_ITEMS_TABLE_NAME);
  if (!campaignTable || !projectTable) {
    const absent = [!campaignTable ? CAMPAIGNS_TABLE_NAME : "", !projectTable ? ACTION_ITEMS_TABLE_NAME : ""].filter(Boolean);
    return { board: null, notes: [`That base has no ${absent.join(" and no ")}, so there was nowhere to write.`] };
  }

  const [campaignRows, projectRows] = await Promise.all([listRecords(baseId, campaignTable.id), listRecords(baseId, projectTable.id)]);
  if (!campaignRows.ok) return { board: null, notes: [campaignRows.error] };
  if (!projectRows.ok) return { board: null, notes: [projectRows.error] };

  return { board: { campaignTable, projectTable, campaignRows: campaignRows.data, projectRows: projectRows.data }, notes: [] };
}

export async function syncTrackers(
  baseId: string,
  read: { board: TrackerBoard | null; notes: string[] },
  campaigns: BriefCampaign[],
  /** `null` means the extraction failed, so the project half is skipped entirely. See the caller. */
  items: TrackerItem[] | null,
  today: string,
): Promise<TrackerSyncResult> {
  const result = blank();
  if (!read.board) return { ...result, notes: read.notes };
  const { campaignTable, projectTable, campaignRows, projectRows } = read.board;

  const campaignPlan = planCampaigns(campaigns, campaignRows, choicesFor(campaignTable, "Status"), today);
  result.notes.push(...campaignPlan.notes);
  result.campaigns.finished = campaignPlan.finished;

  // A base set up before `Total Leads` existed has no column for it, and Airtable fails the whole record
  // on an unknown field. The planner names it regardless; here it is dropped for bases that lack it, so
  // an older base still gets every figure it does have rather than none.
  const columns = (campaignTable.fields ?? []).map((field) => field.name);
  const creates = campaignPlan.creates.map((fields) => onlyKnownColumns(fields, columns));
  const updates = campaignPlan.updates.map((update) => ({ id: update.id, fields: onlyKnownColumns(update.fields, columns) }));

  const made = await createRecords(baseId, campaignTable.id, creates);
  if (!made.ok) result.notes.push(made.error);
  else result.campaigns.created = made.data.length;

  const changed = await updateRecords(baseId, campaignTable.id, updates);
  if (!changed.ok) result.notes.push(changed.error);
  else result.campaigns.updated = changed.data.length;

  // Built from the rows that exist now, the newly created ones included, so an item raised about a
  // campaign the brief has only just recorded still links to it on this run rather than the next.
  const campaignIds = new Map<string, string>();
  for (const row of [...campaignRows, ...(made.ok ? made.data : [])]) {
    const code = String(row.fields["Campaign Code"] ?? "").trim().toUpperCase() || campaignCode(String(row.fields.Title ?? ""));
    if (code) campaignIds.set(code, row.id);
  }

  if (!items) return { ...result, ran: true, notes: [...result.notes, "The action items could not be read out of the brief, so the project tracker was left exactly as it was."] };

  const projectPlan = planProjects(
    items,
    projectRows,
    {
      status: choicesFor(projectTable, "Status"),
      type: choicesFor(projectTable, "Type"),
      source: choicesFor(projectTable, "Source"),
      priority: choicesFor(projectTable, "Priority"),
    },
    campaignIds,
    today,
  );
  result.notes.push(...projectPlan.notes);

  const added = await createRecords(baseId, projectTable.id, projectPlan.creates);
  if (!added.ok) result.notes.push(added.error);
  else result.projects.created = added.data.length;

  const touched = await updateRecords(baseId, projectTable.id, projectPlan.updates);
  if (!touched.ok) result.notes.push(touched.error);
  else result.projects.updated = touched.data.length;

  const removed = await deleteRecords(baseId, projectTable.id, projectPlan.deletes);
  if (!removed.ok) result.notes.push(removed.error);
  else result.projects.removed = removed.data.length;

  return { ...result, ran: true };
}
