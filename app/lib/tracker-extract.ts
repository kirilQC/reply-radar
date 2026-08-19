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
 * Measured against the card, not guessed. A gallery card gives the title two lines and cuts the rest
 * off mid-word with an ellipsis, and two lines at that column width is around forty characters — so
 * sixty-four, which the first version used, produced a board where most titles ended in "…" and every
 * card had to be opened to be understood. That is the flooded view this feature exists to prevent,
 * arriving by a different route.
 */
export const TITLE_MAX = 40;

export type TrackerItem = {
  /** Short enough to read on a card. The detail goes in `detail`. */
  title: string;
  type: "Action Item" | "Project" | "Bottleneck";
  status: "Not Started" | "In Progress" | "Blocked";
  priority: "Urgent" | "High" | "Medium" | "Low";
  /** A person's name, never a Slack id. May be a group rather than a person. See `resolveOwner`. */
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
const PRIORITIES = new Set(["Urgent", "High", "Medium", "Low"]);
const SOURCES = new Set(["Internal channel", "Client channel", "Call"]);

const EXTRACT_PROMPT = `You turn a morning brief that has already been sent into rows for a project tracker.

You are not deciding what is outstanding. The brief decided that. Your job is to write down what it
said, once per item, in a shape a table can hold. Do not add an item the brief does not raise. Do not
leave one out because it seems minor.

Return JSON and nothing else: an object with one key, "items", holding an array. Each item has:

  title    Four to seven words, at most ${TITLE_MAX} characters. It is read on a card in a gallery view
           that gives it two lines and cuts the rest off mid-word, so anything longer arrives
           unreadable. Start with the verb where there is one. No owner name, no dates, no evidence,
           no colon and nothing after it, no trailing clause naming who asked or when.
           Write "Add two senders to BV007". Not "Kiril to add the two additional senders that Kori
           asked for on Aug 17 to BV007: ASCs v2".
           Write "Chase HubSpot bounce issue". Not "Investigate HubSpot email bounce issue and
           confirm whether the domain warmup completed".
  type     One of "Action Item", "Project", "Bottleneck". A Bottleneck is something waiting on
           somebody else or contradicted by the figures. A Project is a body of work with no single
           next step. Everything else is an Action Item.
  status   One of "Not Started", "In Progress", "Blocked". Blocked only where the brief says it is
           waiting on somebody.
  priority One of "Urgent", "High", "Medium", "Low". Urgent is only for something stopping sending
           today or already late to the client. High is something with a named date this week or a
           campaign waiting on it. Low is housekeeping nobody is waiting on. When the brief gives you
           nothing to go on, say "Medium".
  owner    The person's name in plain words: "Kiril Ivlev", not "<@U04AB12CD>" and never a bare user
           id like "U04AB12CD". The roster under the brief says which name each code belongs to — use
           it. Several names comma separated. A group name is fine. Empty string if the brief named
           nobody, never a guess.
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
  {
    model = MODEL,
    timeoutMs = REQUEST_TIMEOUT_MS,
    /** Everyone the brief was allowed to mention, so an owner comes back as a name. */
    people = [],
  }: { model?: string; timeoutMs?: number; people?: Array<{ id: string; name: string }> } = {},
): Promise<{ items: TrackerItem[]; error: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { items: [], error: "ANTHROPIC_API_KEY is not set." };
  const codes = signals.campaigns.names.map((campaign) => campaign.name).join(", ");
  const names = rosterOf(people);
  const roster = [...names].map(([id, name]) => `- <@${id}> is ${name}`).join("\n");
  const content = [
    `The brief that was just sent:\n\n${brief}`,
    `The campaigns it can refer to, so you use the right code: ${codes || "none recorded"}`,
    // The brief is written for Slack, so every owner in it is a `<@U…>` code. Handed over the codes
    // read as owners called U0A2TQ1V49Y, which is what the tracker filled up with before this.
    roster ? `Who the mention codes in that brief refer to:\n${roster}` : "Nobody in that brief has a mention code on file, so write owners exactly as the brief words them.",
  ].join("\n\n");
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
    return { items: parseTrackerItems(text, names), error: "" };
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
export function parseTrackerItems(text: string, names: Map<string, string> = new Map()): TrackerItem[] {
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
      // Medium rather than blank. A priority column that is mostly empty cannot be sorted on, which is
      // the only thing anybody wants a priority column for.
      priority: pick(record.priority, PRIORITIES, "Medium") as TrackerItem["priority"],
      owner: resolveOwner(record.owner, names),
      detail: String(record.detail ?? "").trim(),
      source: pick(record.source, SOURCES, "Internal channel") as TrackerItem["source"],
      campaignCode: String(record.campaignCode ?? "").trim().toUpperCase(),
      key,
    });
  }
  return items;
}

/** Ids to names, first name wins, ignoring anything that is not a usable pair. */
export function rosterOf(people: Array<{ id: string; name: string }>): Map<string, string> {
  const names = new Map<string, string>();
  for (const person of people) {
    const id = String(person?.id ?? "").trim().toUpperCase();
    const name = String(person?.name ?? "").trim();
    if (id && name && !names.has(id)) names.set(id, name);
  }
  return names;
}

/*
 * Slack ids and Slack markup are matched separately because the model returns both forms. `<@U…>` is
 * the code copied straight out of the brief; a bare `U0A2TQ1V49Y` is what is left after a previous
 * version of this file stripped the punctuation off one and called it a name.
 */
const MENTION = /<@([UWB][A-Z0-9]{2,})(?:\|[^>]*)?>/gi;
const BARE_ID = /@?\b([UWB][A-Z0-9]{7,})\b/g;

/**
 * An owner as a person's name, with every Slack id either translated or dropped.
 *
 * Dropped, not kept, when the roster has never heard of the id. The Owner column is read by people and
 * grouped on, and `U09BWJMV8DT` is not a worse name than "Dan" — it is not a name, so it makes the
 * column unreadable and unsortable at once. Blank says "the brief named nobody we can identify", which
 * is true and is at least actionable.
 */
export function resolveOwner(value: unknown, names: Map<string, string>): string {
  const named = (id: string) => names.get(id.toUpperCase()) ?? "";
  const text = String(value ?? "")
    .replace(MENTION, (_whole, id: string) => named(id))
    .replace(BARE_ID, (_whole, id: string) => named(id))
    .replace(/@/g, "");
  // Split on the separator the prompt asks for so that one unknown id out of two owners leaves the
  // other one standing rather than leaving a dangling comma behind it.
  return text.split(",").map((part) => part.trim()).filter(Boolean).join(", ");
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
