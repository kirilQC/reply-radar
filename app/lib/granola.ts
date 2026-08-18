// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Granola's public API, and the one question we ask it: what was said on this client's last call.
 *
 * ── Every key is asked, because no one person is on every call ────────────────────────────────────
 * A Granola key sees only its owner's meetings. Kiril is not on the Bluevia weekly and Kori is not on
 * the Cotool one, so a single key would silently return nothing for most of the roster — and "no call
 * found" is indistinguishable from "no call happened" unless you know whose key was asked. Every stored
 * key is asked at once and the most recent matching meeting across all of them wins.
 *
 * Asking ten keys in parallel is one burst of ten requests. Granola allows twenty-five in five seconds,
 * so the parallelism is what keeps this inside the route's budget rather than something to apologise for.
 *
 * ── A missing transcript must never fail a brief ─────────────────────────────────────────────────
 * The call is the third of three sources. A revoked key, a client with no domains configured, or a week
 * with no call at all are all ordinary states, and each one returns a reason rather than throwing. The
 * brief then says which source it was missing, which is what gets it fixed.
 */

import { callAgeDays, emailBearingFields, normalizeNote, parseDomains, pickLatestCall, transcriptText, type GranolaNote } from "./granola-match";

const BASE = "https://public-api.granola.ai/v1";
/** Granola's list endpoint caps at 30, and one page is several weeks of one person's meetings. */
const PAGE_SIZE = 30;
/**
 * Short on purpose, and it has to be. Two of these run in sequence — list the notes, then fetch the
 * winner's transcript — before a 40s model call, inside a 60s function ceiling. Six seconds each leaves
 * the budget intact even when Granola is having a slow morning.
 */
const TIMEOUT_MS = 6_000;
/**
 * About six thousand words. Longer calls are cut from the front rather than the back, because the last
 * ten minutes of a client call is where next steps get agreed and that is the part a brief is for.
 */
const MAX_TRANSCRIPT_CHARS = 24_000;

type Row = Record<string, unknown>;

export type GranolaKey = { id: string; label: string; apiKey: string };

export type ClientCall = {
  noteId: string;
  title: string;
  startedAt: number;
  ageDays: number | null;
  /** Whose key found it, so a brief can say where the context came from. */
  owner: string;
  summary: string;
  transcript: string;
  truncated: boolean;
};

async function granola(apiKey: string, path: string): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) {
    // Granola's own message names the cause — a revoked key, a plan without API access, a note still
    // processing. All three are things the person holding the key can act on, and none of them are
    // guessable from "HTTP 403".
    const detail = (await response.json().catch(() => null)) as { message?: string; error?: string } | null;
    const because = detail?.message || detail?.error || "";
    if (response.status === 401 || response.status === 403) {
      throw new Error(because || "Granola rejected this key. It may have been revoked, or the workspace may not have API access enabled.");
    }
    if (response.status === 429) throw new Error("Granola is rate limiting these requests. Try again in a minute.");
    throw new Error(because || `Granola refused the request: HTTP ${response.status}`);
  }
  return response.json();
}

/** The notes array out of whichever envelope the API used. */
function notesOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const body = (payload ?? {}) as Row;
  for (const key of ["notes", "data", "documents", "items", "results"]) {
    if (Array.isArray(body[key])) return body[key] as unknown[];
  }
  return [];
}

/** Whether a key works, and how many notes it can see. Used by the Test button on the config page. */
export async function verifyKey(apiKey: string): Promise<{ ok: boolean; notes: number; error?: string }> {
  try {
    return { ok: true, notes: notesOf(await granola(apiKey, "/notes?page_size=1")).length };
  } catch (error) {
    return { ok: false, notes: 0, error: error instanceof Error ? error.message : "This key could not be checked." };
  }
}

/**
 * The client's most recent call, from whichever teammate's key has it.
 *
 * `errors` is returned alongside rather than thrown because a broken key is worth reporting on the page
 * while the brief still goes out with the other two sources. One dead key must not cost the team a brief.
 */
export async function findClientCall(
  keys: GranolaKey[],
  rawDomains: unknown,
  windowDays: number,
): Promise<{ call: ClientCall | null; errors: string[]; reason?: string }> {
  const domains = parseDomains(rawDomains);
  if (!domains.length) return { call: null, errors: [], reason: "No client email domains are configured, so their call cannot be identified." };
  if (!keys.length) return { call: null, errors: [], reason: "No Granola API keys have been added, so no call transcripts can be read." };

  const createdAfter = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const query = `/notes?created_after=${encodeURIComponent(createdAfter)}&page_size=${PAGE_SIZE}`;
  const errors: string[] = [];

  const perKey = await Promise.all(
    keys.map(async (key) => {
      try {
        return { key, notes: notesOf(await granola(key.apiKey, query)) };
      } catch (error) {
        errors.push(`${key.label || "A Granola key"}: ${error instanceof Error ? error.message : "could not be read."}`);
        return { key, notes: [] as unknown[] };
      }
    }),
  );

  // Matched per key so the winner carries the label of whoever's key found it, then compared across
  // keys. The same meeting often appears under two people's keys; taking the newest of the per-key
  // winners lands on one of the duplicates arbitrarily, which is correct — they are the same meeting.
  let winner: { note: GranolaNote; key: GranolaKey } | null = null;
  for (const { key, notes } of perKey) {
    const note = pickLatestCall(notes, domains);
    if (note && (!winner || note.startedAt > winner.note.startedAt)) winner = { note, key };
  }
  if (!winner) {
    return { call: null, errors, reason: `No meeting with anyone from ${domains.join(" or ")} was found in the last ${windowDays} days.` };
  }

  const { note, key } = winner;
  let transcript = "";
  try {
    transcript = transcriptText(await granola(key.apiKey, `/notes/${encodeURIComponent(note.id)}/transcript`));
  } catch (error) {
    errors.push(`The transcript for "${note.title}" could not be read: ${error instanceof Error ? error.message : "unknown reason"}.`);
  }

  const truncated = transcript.length > MAX_TRANSCRIPT_CHARS;
  return {
    call: {
      noteId: note.id,
      title: note.title,
      startedAt: note.startedAt,
      ageDays: callAgeDays(note.startedAt),
      owner: key.label || "a teammate",
      summary: note.summary.slice(0, 6_000),
      transcript: truncated ? transcript.slice(-MAX_TRANSCRIPT_CHARS) : transcript,
      truncated,
    },
    errors,
  };
}

/**
 * What each key can actually see, for when a call that definitely happened was definitely not found.
 *
 * There are exactly two reasons for that, and they need opposite fixes: either the note is not in this
 * person's Granola at all — Granola holds notes for the meetings *you* recorded, so a call somebody else
 * took notes on is in their account and needs their key — or the note is there and the attendee emails
 * are not where `noteDomains` looks. Listing the titles with the domains found beside them separates the
 * two in one request, which is the difference between adding a teammate's key and fixing a parser.
 *
 * Titles and dates only. The transcript is the sensitive part and no diagnostic needs it.
 */
export type NoteSighting = {
  keyLabel: string;
  error: string;
  /**
   * The field names the API actually returned, from the first note. When every note matches no domain,
   * this says whether an attendee field was even in the response — which is the difference between a
   * one-line parser fix and a second request per note.
   */
  fields: string[];
  notes: Array<{
    id: string;
    title: string;
    startedAt: number;
    domains: string[];
    /** Where addresses actually are in this note, when `domains` says the matcher found none. */
    emailFields: Array<{ field: string; domains: string[] }>;
  }>;
};

export async function inspectNotes(keys: GranolaKey[], windowDays: number): Promise<NoteSighting[]> {
  const createdAfter = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const query = `/notes?created_after=${encodeURIComponent(createdAfter)}&page_size=${PAGE_SIZE}`;
  return Promise.all(keys.map(async (key) => {
    try {
      const notes = notesOf(await granola(key.apiKey, query));
      return {
        keyLabel: key.label || "A Granola key",
        error: "",
        fields: Object.keys((notes[0] ?? {}) as Row).sort(),
        // A note `normalizeNote` refused could never have been chosen as a client's call either, so
        // leaving it out keeps this list honest about what was actually in play.
        notes: notes
          .map((raw) => ({ raw, note: normalizeNote(raw) }))
          .filter((pair): pair is { raw: unknown; note: GranolaNote } => Boolean(pair.note))
          .map(({ raw, note }) => ({
            id: note.id,
            title: note.title,
            startedAt: note.startedAt,
            domains: note.domains,
            emailFields: emailBearingFields(raw),
          })),
      };
    } catch (error) {
      return { keyLabel: key.label || "A Granola key", error: error instanceof Error ? error.message : "could not be read.", fields: [], notes: [] };
    }
  }));
}
