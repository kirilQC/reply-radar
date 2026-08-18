// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The three parts of a morning brief that reach outside the process: the stored prompt, the Slack
 * channels, and Anthropic.
 *
 * Split from `morning-brief.ts` so that file has no relative imports at all. That is not tidiness — it
 * is what lets the tests import the arithmetic and run it, and the arithmetic is the part of a brief
 * that has to be right. A test that had to reach a Slack token to check a percentage would not be
 * written, and then the percentage would go unchecked.
 */

import {
  BRIEF_MAX_MESSAGES,
  BRIEF_WINDOW_DAYS,
  CALL_WINDOW_DAYS,
  DEFAULT_MORNING_BRIEF_PROMPT,
  morningBriefPromptKey,
  type BriefInputs,
  type BriefWorkspace,
} from "./morning-brief";
import { channelHistory, resolveUserNames, transcript } from "./slack";
import { findClientCall, type ClientCall, type GranolaKey } from "./granola";
import { readConfig } from "./app-config";

/** Exported so the trace can name the model that was actually asked, rather than a second copy of it. */
export const BRIEF_MODEL = "claude-sonnet-4-6";
/** A brief is 120–300 words by design, so this is headroom rather than a target. */
const MAX_OUTPUT_TOKENS = 1_400;
/**
 * Inside Hobby's 60s function ceiling, with room for the two Granola calls that now run first and for
 * writing the row afterwards. Was 45s, which left nothing for the transcript fetch.
 */
const REQUEST_TIMEOUT_MS = 40_000;

type Row = Record<string, unknown>;

/** The stored instructions for this client, then the global ones, then the built-in default. */
export async function morningBriefPrompt(slug?: string | null): Promise<string> {
  const asText = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const scoped = slug ? asText(await readConfig(morningBriefPromptKey(slug)).catch(() => "")) : "";
  if (scoped) return scoped;
  const global = asText(await readConfig(morningBriefPromptKey()).catch(() => ""));
  return global || DEFAULT_MORNING_BRIEF_PROMPT;
}

/**
 * Reads both channels, or reports why it could not.
 *
 * A channel that cannot be read must not fail the brief. The commonest reason by far is that nobody
 * invited the bot, and a brief that says "the internal channel could not be read: the bot is not in
 * that channel" is what gets that fixed. A brief that fails silently, or fails entirely, does not.
 */
export async function gatherChannels(workspace: BriefWorkspace): Promise<Pick<BriefInputs, "internal" | "external">> {
  const timezone = workspace.timezone || "America/New_York";
  const readChannel = async (channelId: string) => {
    if (!channelId) return { channelId: "", messages: 0, raw: 0, capped: false, text: "" };
    try {
      const history = await channelHistory(channelId, BRIEF_WINDOW_DAYS, BRIEF_MAX_MESSAGES);
      const names = await resolveUserNames(history.messages.map((message) => message.author));
      return {
        channelId,
        messages: history.messages.length,
        raw: history.raw,
        // Slack returned exactly as many as were asked for, which means there were probably more.
        capped: history.raw >= BRIEF_MAX_MESSAGES,
        text: transcript(history.messages, names, timezone),
      };
    } catch (error) {
      return { channelId, messages: 0, raw: 0, capped: false, text: "", error: error instanceof Error ? error.message : "This channel could not be read." };
    }
  };
  const [internal, external] = await Promise.all([
    readChannel(String(workspace.slack_internal_channel_id ?? "")),
    readChannel(String(workspace.slack_external_channel_id ?? "")),
  ]);
  return { internal, external };
}

/** Every stored Granola key. Read on each run so a key added minutes ago is used by the next brief. */
export async function granolaKeys(read: (path: string) => Promise<unknown>): Promise<GranolaKey[]> {
  const rows = await read("rr_granola_keys?select=id,label,api_key&order=created_at.asc").catch(() => []);
  return (Array.isArray(rows) ? (rows as Row[]) : [])
    .map((row) => ({ id: String(row.id ?? ""), label: String(row.label ?? ""), apiKey: String(row.api_key ?? "") }))
    .filter((key) => key.apiKey);
}

/**
 * The client's last call, or the reason there isn't one.
 *
 * Never throws. A missing transcript is one of three sources going quiet, and the brief is more useful
 * with two sources and a line saying what it is missing than not written at all.
 */
export async function gatherCall(
  read: (path: string) => Promise<unknown>,
  workspace: BriefWorkspace,
): Promise<{ call: ClientCall | null; callReason?: string; errors: string[] }> {
  try {
    const keys = await granolaKeys(read);
    const found = await findClientCall(keys, workspace.granola_title_match, workspace.name, CALL_WINDOW_DAYS);
    return { call: found.call, callReason: found.reason, errors: found.errors };
  } catch (error) {
    return { call: null, callReason: error instanceof Error ? error.message : "The call transcript could not be read.", errors: [] };
  }
}

/** Calls Anthropic once and returns the brief. One call, because a brief is short by design. */
export async function writeBrief(systemPrompt: string, userContent: string, model = BRIEF_MODEL): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set, so no brief can be written.");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Not zero: the same figures every Monday would otherwise produce nearly the same sentences, and
      // a brief that reads as boilerplate stops being read even when the contents changed.
      temperature: 0.3,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error?.message ?? `HTTP ${response.status}`;
    throw new Error(`Anthropic refused the request: ${detail}`);
  }
  const text = Array.isArray(payload?.content)
    ? payload.content.filter((part: Row) => part?.type === "text").map((part: Row) => String(part.text ?? "")).join("").trim()
    : "";
  if (!text) throw new Error("Anthropic returned an empty brief.");
  return text;
}
