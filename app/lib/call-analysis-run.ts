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
