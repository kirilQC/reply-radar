// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The weekly call, written out as a file the QC Brain keeps.
 *
 * ── Why this exists next to `callAnalysisRow` ────────────────────────────────────────────────────
 * The recap is already filed into the client's Weekly Calls table on every run. The brain wants the same
 * facts, because it is the agency's shared memory and a person reading a client in the brain should see
 * their weekly calls there without opening Airtable. So this builds the same field set as a markdown
 * document: the row's columns as frontmatter, the recap and then the full transcript as the body.
 *
 * ── Why the transcript is uncut here ─────────────────────────────────────────────────────────────
 * The Airtable Transcript column tops out near a hundred thousand characters and `callAnalysisRow` slices
 * to fit it. A file in a git repository has no such cell, so the whole of `call.transcript` is written —
 * which is already the last 320,000 characters `gatherCalls` kept, the fullest copy that exists anywhere
 * in the system. The brain is where the complete record belongs.
 *
 * ── Why it is pure ───────────────────────────────────────────────────────────────────────────────
 * The same split the rest of the call analysis keeps: no relative value imports, so a test can assert the
 * path and the document without a GitHub token or a clock. Resolving which brain folder a client is, and
 * the write itself, live in `call-analysis-run.ts`.
 */

import type { ClientCall } from "./granola";
import type { BriefWorkspace } from "./morning-brief";
import type { CallAnalysisDestination } from "./call-analysis";

/**
 * The four destinations, spelled as the Weekly Calls `Posted To` options are.
 *
 * Mirrored from `call-analysis.ts` rather than imported: this file takes no relative value imports so it
 * stays testable in isolation, and a four-entry map is a cheaper thing to keep in step than a value import
 * into a pure module. Both must read the same, since a person comparing the Airtable row to this file
 * should see the same word.
 */
const POSTED_TO: Record<string, string> = { preview: "Preview", test: "Test", internal: "Internal", external: "External" };

/**
 * A call title as a filename-safe slug, matching the brain's own `YYYY-MM-DD-<slug>.md` call-note naming.
 *
 * Lower-cased, non-alphanumerics collapsed to single hyphens, trimmed and capped — so a title turns into
 * the same fragment every run, which is what makes the path idempotent: a re-run of the same call resolves
 * to the same file and overwrites it rather than filing a second copy.
 */
export function weeklyCallSlug(title: string): string {
  const slug = String(title ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "weekly-call";
}

/** A YAML scalar that is safe to write, double-quoted whenever plain form could be misread (titles carry colons). */
const yaml = (value: string): string => {
  const text = String(value ?? "");
  if (!text) return '""';
  return /[:#"'[\]{}|>&*!?%@`]|^[\s-]|\s$/.test(text) ? JSON.stringify(text) : text;
};

/**
 * One weekly call as a brain document: `{ path, text }`, ready for `writeBrainFile`.
 *
 * The path is `clients/<folder>/Weekly calls/<call date>-<title slug>.md`, keyed by the day of the call and
 * its title so a re-run lands on the same file. The frontmatter carries every Weekly Calls column — a field
 * with nothing to say is left off rather than written blank, the same rule `callAnalysisRow` follows — and
 * the body is the recap followed by the whole transcript.
 */
export function weeklyCallBrainDoc(
  folder: string,
  workspace: BriefWorkspace,
  input: { call: ClientCall; recap: string; destination: CallAnalysisDestination; syncedAt?: Date },
): { path: string; text: string } {
  const timezone = workspace.timezone || "America/New_York";
  const callDate = new Date(input.call.startedAt).toLocaleDateString("en-CA", { timeZone: timezone });
  const syncedAt = (input.syncedAt ?? new Date()).toISOString().slice(0, 10);
  const attendees = input.call.attendees.join(", ");

  const path = `clients/${folder}/Weekly calls/${callDate}-${weeklyCallSlug(input.call.title)}.md`;

  const front: string[] = [
    `title: ${yaml(input.call.title)}`,
    `call_date: ${callDate}`,
    `call_id: ${yaml(input.call.noteId)}`,
    `posted_to: ${POSTED_TO[input.destination] ?? "Preview"}`,
  ];
  if (attendees) front.push(`attendees: ${yaml(attendees)}`);
  if (input.call.owner) front.push(`host: ${yaml(input.call.owner)}`);
  if (input.call.durationMinutes) front.push(`duration_min: ${input.call.durationMinutes}`);
  front.push(`last_synced: ${syncedAt}`);

  const text = [
    "---",
    front.join("\n"),
    "---",
    "",
    `# ${input.call.title || "Weekly call"} — ${callDate}`,
    "",
    "## Recap",
    "",
    input.recap.trim() || "_No recap was generated for this call._",
    "",
    "## Transcript",
    "",
    input.call.transcript.trim() || "_No transcript was captured for this call._",
    "",
  ].join("\n");

  return { path, text };
}
