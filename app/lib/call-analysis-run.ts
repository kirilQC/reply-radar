// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The one part of a call analysis that reaches outside the process: its stored prompt.
 *
 * Split from `call-analysis.ts` for the same reason the morning brief's run file is split from its own —
 * that file has no relative value imports, so the prompt text and the content builder can be asserted on
 * directly in a test. Everything else a call analysis needs already exists: the transcript is fetched by
 * `gatherCalls` and the model is called by `writeBrief`, both in `morning-brief-run.ts`, so this file is
 * only the prompt resolution the analysis does not share with the brief.
 */

import { callAnalysisPromptKey, callAnalysisRow, DEFAULT_CALL_ANALYSIS_PROMPT, type CallAnalysisDestination } from "./call-analysis";
import { recapPlainText } from "./brief-format";
import { readConfig } from "./app-config";
import {
  createRecords,
  findTableByName,
  getBaseTables,
  listRecords,
  updateRecords,
  WEEKLY_CALLS_TABLE_NAME,
} from "./airtable";
import { brainConfigured, brainTree, writeBrainFile } from "./brain";
import { brainFolderFor } from "../../shared/brain-link.mjs";
import { clientsIn } from "../../shared/brain-structure.mjs";
import { weeklyCallBrainDoc } from "./weekly-call-brain";
import type { ClientCall } from "./granola";
import type { BriefWorkspace } from "./morning-brief";

/** The stored instructions for this client, then the global ones, then the built-in default. */
export async function callAnalysisPrompt(slug?: string | null): Promise<string> {
  const asText = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const scoped = slug ? asText(await readConfig(callAnalysisPromptKey(slug)).catch(() => "")) : "";
  if (scoped) return scoped;
  const global = asText(await readConfig(callAnalysisPromptKey()).catch(() => ""));
  return global || DEFAULT_CALL_ANALYSIS_PROMPT;
}

export type WeeklyCallFileResult = { filed: "created" | "updated" | null; note: string };

/**
 * Files one recap into the client's Weekly Calls table, or says why it could not.
 *
 * Runs after the recap is posted, so like the brief's tracker sync it never throws and never turns a
 * delivered recap into a failed run — every reason it stopped comes back as a note for the trace. Keyed
 * on the Granola note id: a call already filed is updated in place rather than duplicated, so re-running
 * the same analysis leaves one row per meeting however many times the button is pressed.
 */
export async function fileWeeklyCall(
  baseId: string,
  workspace: BriefWorkspace,
  input: { call: ClientCall; recap: string; destination: CallAnalysisDestination; mentions?: Record<string, string> },
): Promise<WeeklyCallFileResult> {
  if (!baseId) return { filed: null, note: "No Airtable base is mapped to this client, so the recap was not filed." };

  const schema = await getBaseTables(baseId);
  if (!schema.ok) return { filed: null, note: schema.error };
  const table = findTableByName(schema.data, WEEKLY_CALLS_TABLE_NAME);
  if (!table) return { filed: null, note: `That base has no ${WEEKLY_CALLS_TABLE_NAME} table, so there was nowhere to file the recap.` };

  const rows = await listRecords(baseId, table.id);
  if (!rows.ok) return { filed: null, note: rows.error };

  // The recap posted to Slack is stored as Slack mrkdwn; a spreadsheet cell renders none of it, so it is
  // flattened to plain text on the way in, with the same mention map the recap was written against.
  const recap = recapPlainText(input.recap, input.mentions ?? {});
  const fields = callAnalysisRow(workspace, { call: input.call, recap, destination: input.destination });
  // Transcript is a newer column. A base set up before it exists still files its recap rather than failing
  // the whole write on an unknown field; once the setup button adds the column, transcripts start landing.
  const hasTranscript = (table.fields ?? []).some((field) => field.name.trim().toLowerCase() === "transcript");
  if (!hasTranscript) delete fields.Transcript;
  const existing = rows.data.find((row) => String(row.fields["Call ID"] ?? "").trim() === input.call.noteId);

  if (existing) {
    const changed = await updateRecords(baseId, table.id, [{ id: existing.id, fields }]);
    return changed.ok ? { filed: "updated", note: "" } : { filed: null, note: changed.error };
  }

  const made = await createRecords(baseId, table.id, [fields]);
  return made.ok ? { filed: "created", note: "" } : { filed: null, note: made.error };
}

/**
 * Files the same recap into the client's QC Brain folder, or says why it could not.
 *
 * The brain's sibling of `fileWeeklyCall`: the identical field set, plus the whole untruncated transcript,
 * written as a markdown file under `clients/<folder>/Weekly calls/`. Every field that lands in Airtable
 * lands here too, so a person reading the client in the brain sees their calls without opening the base.
 *
 * Runs after the recap is posted and, like every filing step, never throws and never turns a delivered
 * recap into a failed run — a brain that is not connected, a client with no matching folder, or a GitHub
 * hiccup all come back as a note for the trace. The client is matched to its folder with the same
 * `brainFolderFor` rule the QC Brain tab and the morning brief use, so one client never files under
 * another's folder. The path is keyed on the day of the call and its title, so a re-run overwrites the
 * one file rather than filing a second.
 */
export async function fileWeeklyCallToBrain(
  workspace: BriefWorkspace,
  input: { call: ClientCall; recap: string; destination: CallAnalysisDestination; mentions?: Record<string, string> },
): Promise<WeeklyCallFileResult> {
  if (!brainConfigured()) return { filed: null, note: "The QC Brain is not connected, so the recap was not filed to it." };

  try {
    const paths = (await brainTree()).map((file) => file.path);
    const { folder } = brainFolderFor(
      { slug: workspace.slug, name: workspace.name, brainFolder: workspace.brain_folder },
      clientsIn(paths),
    ) as { folder: string };
    if (!folder) return { filed: null, note: `No QC Brain folder matches ${workspace.name || "this client"}, so the recap was not filed to it.` };

    // The recap is stored as Slack mrkdwn; the brain reads as plain markdown, so it is flattened the same
    // way the Airtable cell is, against the same mention map the recap was written with.
    const recap = recapPlainText(input.recap, input.mentions ?? {});
    const { path, text } = weeklyCallBrainDoc(folder, workspace, { call: input.call, recap, destination: input.destination });
    const existed = paths.includes(path);

    const written = await writeBrainFile({
      path,
      text,
      summary: `Weekly call recap: ${workspace.name} (${weeklyCallDate(workspace, input.call.startedAt)})`,
      author: "Reply Radar",
    });
    // `writeBrainFile` reports created vs replaced from the SHA it found; the tree lookup is the fallback
    // for the rare case the file was written between the two reads.
    return { filed: written.created && !existed ? "created" : "updated", note: "" };
  } catch (error) {
    return { filed: null, note: error instanceof Error ? error.message : "The recap could not be filed to the QC Brain." };
  }
}

/** The day of the call in the client's zone, for the commit message — the same date the file is named for. */
function weeklyCallDate(workspace: BriefWorkspace, startedAt: number): string {
  return new Date(startedAt).toLocaleDateString("en-CA", { timeZone: workspace.timezone || "America/New_York" });
}
