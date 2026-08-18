// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Turning the brief people just read into rows a tracker can hold.
 *
 * ── Why this reads the brief rather than the sources ──────────────────────────────────────────────
 * The obvious design is a second look at the same channels and transcripts, deciding independently
 * what is outstanding. It is the wrong one. Two independent readings of the same fortnight disagree,
 * and the disagreement lands in the two places the team looks: Slack says four things are outstanding
 * and Airtable says six, and now nobody trusts either. Reading the posted brief makes the tracker a
 * projection of what was said rather than a second opinion about it, and the two cannot drift.
 *
 * ── Why a model and not a parser ──────────────────────────────────────────────────────────────────
 * The brief is prose with a deliberately loose shape: an owner mention, a sentence, a sub-bullet that
 * comments on it. A regex over that works until the run where somebody's name has an apostrophe in it
 * or the model puts the mention second, and then it silently yields nothing or, worse, half a
 * sentence as a title. This is an extraction task with the source of truth in hand, which is the one
 * thing models are reliably good at, and the failure mode is a wrong row rather than a wrong parse of
 * a right row.
 *
 * ── Why the titles are short here and not tidied later ────────────────────────────────────────────
 * The tracker is read in Airtable's gallery view, where a row is a card and the title is most of what
 * fits. A title that runs on is a card you have to open to understand, and a board of those is the
 * flooded view this whole feature exists to prevent. Truncating afterwards cuts mid-clause; asking for
 * a short title gets a short sentence. The cap below is the backstop for when it does not.
 */
import type { BriefSignals } from "./morning-brief";

const MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 2_000;
const REQUEST_TIMEOUT_MS = 40_000;

/**
 * Long enough for "Add the two additional senders to BV007", short enough that it fits on a gallery
 * card without wrapping to a third line. Measured against the titles already in Bluevia's tracker
 * rather than picked: the ones that read badly there were all past seventy characters.
 */
export const TITLE_MAX = 64;

export type TrackerItem = {
  /** Short enough to read on a card. The detail goes in `detail`. */
  title: string;
  type: "Action Item" | "Project" | "Bottleneck";
  status: "Not Started" | "In Progress" | "Blocked";
  /** As the brief named them, mentions stripped. May be a group rather than a person. */
  owner: string;
  detail: string;
  source: "Internal channel" | "Client channel" | "Call";
  /** The campaign code this concerns, when it concerns one. */
  campaignCode: string;
  /**
   * Stable across re-phrasings of the same item, which is the whole point: the brief says "chase the
   * surgeon offices list" one Monday and "still waiting on the surgeon offices database" the next, and
   * both must find the same row.
   */
  key: string;
};

const TYPES = new Set(["Action Item", "Project", "Bottleneck"]);
const STATUSES = new Set(["Not Started", "In Progress", "Blocked"]);
const SOURCES = new Set(["Internal channel", "Client channel", "Call"]);

const EXTRACT_PROMPT = `You turn a morning brief that has already been sent into rows for a project tracker.

You are not deciding what is outstanding. The brief decided that. Your job is to write down what it
said, once per item, in a shape a table can hold. Do not add an item the brief does not raise. Do not
leave one out because it seems minor.

Return JSON and nothing else: an object with one key, "items", holding an array. Each item has:

  title    A short label, at most ${TITLE_MAX} characters, read on a card in a gallery view. Start with
           the verb where there is one. No owner name, no dates, no evidence, no trailing clause.
           "Add two senders to BV007" not "Kiril to add the two additional senders that Kori asked
           for on Aug 17 to BV007: ASCs v2".
  type     One of "Action Item", "Project", "Bottleneck". A Bottleneck is something waiting on
           somebody else or contradicted by the figures. A Project is a body of work with no single
           next step. Everything else is an Action Item.
  status   One of "Not Started", "In Progress", "Blocked". Blocked only where the brief says it is
           waiting on somebody.
  owner    The name the brief put on it, without the @. Several names comma separated. A group name is
           fine. Empty string if the brief named nobody, never a guess.
  detail   Two or three sentences: what was said, by whom, when, and what has not happened since.
           Everything you kept out of the title goes here.
  source   One of "Internal channel", "Client channel", "Call".
  campaignCode  The campaign code such as BV007 when the item is about one campaign, else "".
  key      A short lowercase hyphenated slug naming the thing itself, not the phrasing: "bv007-senders",
           "surgeon-offices-list", "doximity-enrichment". The same item must produce the same slug on a
           later brief that words it differently. No dates in it.

If the brief raises nothing to work on, return {"items": []}.`;

/**
 * One extra model call. Returns an empty list rather than throwing.
 *
 * The brief has already been posted by the time this runs, and a failure here must not turn a
 * delivered brief into a failed one. The caller reports the reason and the next run tries again with
 * the same items still in the brief, so nothing is lost by giving up quietly this morning.
 */
export async function extractTrackerItems(
  brief: string,
  signals: BriefSignals,
  { model = MODEL, timeoutMs = REQUEST_TIMEOUT_MS }: { model?: string; timeoutMs?: number } = {},
): Promise<{ items: TrackerItem[]; error: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { items: [], error: "ANTHROPIC_API_KEY is not set." };
  const codes = signals.campaigns.names.map((campaign) => campaign.name).join(", ");
  const content = `The brief that was just sent:\n\n${brief}\n\nThe campaigns it can refer to, so you use the right code: ${codes || "none recorded"}`;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        // Zero here, unlike the brief. The brief is written to be read and the same figures every week
        // should not produce the same sentences; this is a transcription, and variation in it is the
        // same item coming back under a different key and landing as a second row.
        temperature: 0,
        system: EXTRACT_PROMPT,
        messages: [{ role: "user", content }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { items: [], error: `Anthropic refused the extraction: ${payload?.error?.message ?? `HTTP ${response.status}`}` };
    const text = Array.isArray(payload?.content)
      ? payload.content.filter((part: { type?: string }) => part?.type === "text").map((part: { text?: string }) => String(part.text ?? "")).join("").trim()
      : "";
    return { items: parseTrackerItems(text), error: "" };
  } catch (error) {
    return { items: [], error: error instanceof Error ? error.message : "The extraction call failed." };
  }
}

/**
 * Reads the model's JSON and throws away anything that is not a usable row.
 *
 * Kept apart from the call so it can be tested against real output, and strict on purpose: an item
 * with no title or no key cannot be found again on the next run, so it would land as a fresh row every
 * morning. Better one missing row than a tracker that grows a copy of it three times a week.
 */
export function parseTrackerItems(text: string): TrackerItem[] {
  // Models fence JSON in markdown perhaps one run in ten, and a fenced object is not a malformed one.
  const body = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let parsed: unknown = null;
  try { parsed = JSON.parse(body); } catch { return []; }
  const rows = Array.isArray((parsed as { items?: unknown })?.items) ? (parsed as { items: unknown[] }).items : [];
  const items: TrackerItem[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const record = (row ?? {}) as Record<string, unknown>;
    const title = clip(String(record.title ?? "").trim(), TITLE_MAX);
    const key = String(record.key ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!title || !key || seen.has(key)) continue;
    seen.add(key);
    items.push({
      title,
      type: pick(record.type, TYPES, "Action Item") as TrackerItem["type"],
      status: pick(record.status, STATUSES, "Not Started") as TrackerItem["status"],
      // The @ survives a surprising number of runs despite the instruction, and a tracker full of
      // "@Kiril Ivlev" is a tracker whose Owner column cannot be grouped on.
      owner: String(record.owner ?? "").replace(/@/g, "").trim(),
      detail: String(record.detail ?? "").trim(),
      source: pick(record.source, SOURCES, "Internal channel") as TrackerItem["source"],
      campaignCode: String(record.campaignCode ?? "").trim().toUpperCase(),
      key,
    });
  }
  return items;
}

/** An unrecognised value is the model's, not the base's, so it falls back rather than being written. */
function pick(value: unknown, allowed: Set<string>, fallback: string): string {
  const text = String(value ?? "").trim();
  return allowed.has(text) ? text : fallback;
}

/** Cut at a word boundary where there is one within reach, because a title ending mid-word reads as a bug. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max - 16 ? cut.slice(0, space) : cut).trimEnd();
}
