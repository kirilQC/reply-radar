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

import { callAnalysisPromptKey, DEFAULT_CALL_ANALYSIS_PROMPT } from "./call-analysis";
import { readConfig } from "./app-config";

/** The stored instructions for this client, then the global ones, then the built-in default. */
export async function callAnalysisPrompt(slug?: string | null): Promise<string> {
  const asText = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const scoped = slug ? asText(await readConfig(callAnalysisPromptKey(slug)).catch(() => "")) : "";
  if (scoped) return scoped;
  const global = asText(await readConfig(callAnalysisPromptKey()).catch(() => ""));
  return global || DEFAULT_CALL_ANALYSIS_PROMPT;
}
