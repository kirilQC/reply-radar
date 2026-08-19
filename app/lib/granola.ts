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
 * The call is the third of three sources. A revoked key, a renamed invite, or a week with no call at all
 * are all ordinary states, and each one returns a reason rather than throwing. The brief then says which
 * source it was missing, which is what gets it fixed.
 *
 * ── One list request per key, and one detail request in total ─────────────────────────────────────
 * Which meeting belongs to which client is decided entirely from the list response, because the title is
 * in it. Only the winning note is opened, and that one request also carries the transcript. Anything that
 * needs a field per note — attendees, most obviously — does not fit in the budget; see `granola-match.ts`.
 */

import { callAgeDays, describeNeedles, normalizeNote, parseTitleNeedles, pickLatestCall, titleMatches, transcriptText, type GranolaNote } from "./granola-match";

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
 * About sixty thousand words — a four-hour call, where a weekly client sync is forty minutes. This is
 * high enough that in practice nothing is cut, which is the point: the transcript is now the brief's only
 * account of what was said on the call, so a truncated one is a brief that confidently misses a commitment.
 *
 * There is still a ceiling, because a prompt has to fit in the model's context and the route has sixty
 * seconds. If one is ever hit, the cut takes the front rather than the back — the last ten minutes of a
 * client call is where next steps get agreed, and the reader is told the transcript was shortened.
 */
const MAX_TRANSCRIPT_CHARS = 320_000;
/**
 * The ceiling for an *extra* call, which is a fifth of the main one's.
 *
 * An extra call is background — the internal weekly where we decide what we are working on — and the main
 * call is the thing the brief is accountable to. Given equal room in the prompt they would be weighed
 * equally, and three hours of internal chat would drown forty minutes with the client. Sixty thousand
 * characters is a long meeting; the cut takes the front, same as the main transcript, because next steps
 * are agreed at the end.
 */
const EXTRA_TRANSCRIPT_CHARS = 60_000;
/**
 * How many extra calls one brief will read.
 *
 * Not a storage limit — the column holds as many as anybody types. It is a budget limit: each extra call
 * is one more detail request and one more transcript inside a 60s ceiling that already contains a 40s
 * model call. Three is more context than any brief has needed and still fits.
 */
export const MAX_EXTRA_CALLS = 3;

type Row = Record<string, unknown>;

export type GranolaKey = { id: string; label: string; apiKey: string };

export type ClientCall = {
  noteId: string;
  title: string;
  startedAt: number;
  ageDays: number | null;
  /** Whose key found it, so a brief can say where the context came from. */
  owner: string;
  /** Who was on it, by name. Empty when the note carried no attendee list. */
  attendees: string[];
  /** Scheduled length in whole minutes, or null. Shown to a reader; not sent to the model. */
  durationMinutes: number | null;
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

/** Every key's recent notes, in one burst. A key that refuses contributes an error and no notes. */
async function listNotes(keys: GranolaKey[], windowDays: number, errors: string[]) {
  const createdAfter = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const query = `/notes?created_after=${encodeURIComponent(createdAfter)}&page_size=${PAGE_SIZE}`;
  return Promise.all(
    keys.map(async (key) => {
      try {
        return { key, notes: notesOf(await granola(key.apiKey, query)) };
      } catch (error) {
        errors.push(`${key.label || "A Granola key"}: ${error instanceof Error ? error.message : "could not be read."}`);
        return { key, notes: [] as unknown[] };
      }
    }),
  );
}

type Listed = Awaited<ReturnType<typeof listNotes>>;

/**
 * The newest note matching these needles, across every key, ignoring any note already taken.
 *
 * Matched per key so the winner carries the label of whoever's key found it, then compared across keys.
 * The same meeting often appears under two people's keys; taking the newest of the per-key winners lands
 * on one of the duplicates arbitrarily, which is correct — they are the same meeting.
 *
 * `taken` is what stops an extra call from being the main call a second time. Two configured matches will
 * often both hit the same meeting, and a brief that read one call twice would present its own duplicate as
 * corroboration.
 */
function pickWinner(listed: Listed, needles: string[][], taken: Set<string>) {
  let winner: { note: GranolaNote; key: GranolaKey } | null = null;
  for (const { key, notes } of listed) {
    const note = pickLatestCall(notes, needles);
    if (!note || taken.has(note.id)) continue;
    if (!winner || note.startedAt > winner.note.startedAt) winner = { note, key };
  }
  return winner;
}

/**
 * One note opened, with its transcript.
 *
 * The detail request is the only place the transcript exists, and it is also the only place the meeting's
 * own start time does — the list response carries `created_at`, which is when Granola wrote the note, not
 * when the call happened.
 */
async function openCall(
  winner: { note: GranolaNote; key: GranolaKey },
  limit: number,
  errors: string[],
): Promise<ClientCall> {
  const { note, key } = winner;
  let detail: Row = {};
  let transcript = "";
  try {
    detail = ((await granola(key.apiKey, `/notes/${encodeURIComponent(note.id)}?include=transcript`)) ?? {}) as Row;
    transcript = transcriptText(detail.transcript ?? detail);
  } catch {
    // `include=transcript` is refused with 413 when the transcript is very large, and a long call is
    // exactly the one worth reading. Fall back to the paged endpoint, which is where it always was.
    try {
      transcript = transcriptText(await granola(key.apiKey, `/notes/${encodeURIComponent(note.id)}/transcript`));
    } catch (error) {
      errors.push(`The transcript for "${note.title}" could not be read: ${error instanceof Error ? error.message : "unknown reason"}.`);
    }
  }

  const full = normalizeNote({ ...detail, id: note.id, title: detail.title ?? note.title });
  const startedAt = full?.startedAt || note.startedAt;
  const truncated = transcript.length > limit;
  return {
    noteId: note.id,
    title: full?.title || note.title,
    startedAt,
    ageDays: callAgeDays(startedAt),
    owner: key.label || "a teammate",
    // Both come from the detail response and are empty when it could not be read at all, which is the
    // same case where `title` falls back to the list's copy.
    attendees: full?.attendees ?? [],
    durationMinutes: full?.durationMinutes ?? null,
    transcript: truncated ? transcript.slice(-limit) : transcript,
    truncated,
  };
}

/**
 * The client's call, and any extra calls that were asked for.
 *
 * ── One list pass, several winners ───────────────────────────────────────────────────────────────
 * The expensive half of this is asking every key what it can see, and that answer is the same whichever
 * meeting is being looked for. So the notes are listed once and each configured match picks its own winner
 * out of the same pile. Adding a second call to a client therefore costs one detail request, not a second
 * round of ten list requests.
 *
 * ── Why the extras are a separate list and not a longer one ──────────────────────────────────────
 * `titleMatch` names the client's own call: the weekly with them, or a kickoff, or an escalation. That is
 * the meeting the brief is accountable to, and the reason it is singular. `extraMatches` are other
 * meetings that happen to contain useful context — most often our own internal weekly about the account —
 * and they are returned apart so that everything downstream, up to and including the prompt, can keep
 * saying which is which. Returning six calls in one array would have thrown that distinction away here,
 * where it is known, in exchange for the model guessing at it later.
 *
 * `errors` is returned alongside rather than thrown because a broken key is worth reporting on the page
 * while the brief still goes out with the other two sources. One dead key must not cost the team a brief.
 */
export async function findClientCalls(
  keys: GranolaKey[],
  titleMatch: unknown,
  extraMatches: string[],
  clientName: unknown,
  windowDays: number,
): Promise<{ call: ClientCall | null; extras: ClientCall[]; errors: string[]; reason?: string }> {
  const needles = parseTitleNeedles(titleMatch, clientName);
  if (!needles.length) return { call: null, extras: [], errors: [], reason: "This client has no name to look for in meeting titles, so their call cannot be identified." };
  if (!keys.length) return { call: null, extras: [], errors: [], reason: "No Granola API keys have been added, so no call transcripts can be read." };

  const errors: string[] = [];
  const listed = await listNotes(keys, windowDays, errors);
  const taken = new Set<string>();

  const winner = pickWinner(listed, needles, taken);
  if (winner) taken.add(winner.note.id);

  // The extras are chosen before anything is opened, so the primary always gets first refusal on a
  // meeting both matches want, whichever order they are configured in.
  const extraWinners = extraMatches
    .slice(0, MAX_EXTRA_CALLS)
    .map((match) => {
      const extraNeedles = parseTitleNeedles(match, "");
      if (!extraNeedles.length) return null;
      const found = pickWinner(listed, extraNeedles, taken);
      if (found) taken.add(found.note.id);
      return found;
    })
    .filter((found): found is { note: GranolaNote; key: GranolaKey } => Boolean(found));

  // Together, because they are independent requests and the budget is the reason the extras are capped.
  const [call, ...extras] = await Promise.all([
    winner ? openCall(winner, MAX_TRANSCRIPT_CHARS, errors) : Promise.resolve(null),
    ...extraWinners.map((found) => openCall(found, EXTRA_TRANSCRIPT_CHARS, errors)),
  ]);

  return {
    call,
    extras: extras.filter((extra): extra is ClientCall => Boolean(extra)),
    errors,
    reason: call ? undefined : `No meeting with "${describeNeedles(needles)}" in the title was found in the last ${windowDays} days.`,
  };
}

/** The lightest thing worth knowing about a client's last call: enough to key on and to show, no transcript. */
export type CallSighting = {
  noteId: string;
  title: string;
  startedAt: number;
  ageDays: number | null;
  /** Whose key found it. */
  owner: string;
};

/**
 * Each client's most recent matching call, found in one list pass across every key and never opened.
 *
 * This is the hourly heartbeat's question, and it is deliberately not `findClientCalls`: the heartbeat only
 * needs to know *whether* a new call exists and enough about it to show and to key on, so it stops at the
 * list response — the note id, title and start time are all in it — and never fetches a transcript. One
 * burst of list requests answers the whole roster, because the same listed notes serve every client's
 * needles; adding a client to the poll costs nothing but a match against a pile already in hand.
 *
 * A key that refuses contributes an error and no notes, exactly as it does for a brief. A client whose
 * name matches nothing gets `null`, which the caller reads as "no call this week," not as a fault.
 */
export async function latestCallsAcrossKeys(
  keys: GranolaKey[],
  clients: Array<{ slug: string; titleMatch: unknown; clientName: unknown }>,
  windowDays: number,
): Promise<{ found: Record<string, CallSighting | null>; keysSeen: number; errors: string[] }> {
  const errors: string[] = [];
  const found: Record<string, CallSighting | null> = {};
  for (const client of clients) found[client.slug] = null;
  if (!keys.length) return { found, keysSeen: 0, errors: ["No Granola API keys have been added, so no calls can be seen."] };

  const listed = await listNotes(keys, windowDays, errors);
  for (const client of clients) {
    const needles = parseTitleNeedles(client.titleMatch, client.clientName);
    if (!needles.length) continue;
    const winner = pickWinner(listed, needles, new Set());
    if (!winner) continue;
    found[client.slug] = {
      noteId: winner.note.id,
      title: winner.note.title,
      startedAt: winner.note.startedAt,
      ageDays: callAgeDays(winner.note.startedAt),
      owner: winner.key.label || "a teammate",
    };
  }
  return { found, keysSeen: keys.length, errors };
}

/**
 * What each key can actually see, for when a call that definitely happened was definitely not found.
 *
 * There are two reasons for that and they need opposite fixes: either the note is not in this person's
 * Granola at all — Granola holds notes for the meetings *you* recorded, so a call somebody else took notes
 * on is in their account and needs their key — or it is there under a title that does not name the client.
 * Listing every title with a tick beside the ones that match separates the two in one request, which is
 * the difference between adding a teammate's key and typing a name into the config page.
 *
 * Titles and dates only. The transcript is the sensitive part and no diagnostic needs it.
 */
export type NoteSighting = {
  keyLabel: string;
  error: string;
  notes: Array<{ id: string; title: string; startedAt: number; matches: boolean }>;
};

export async function inspectNotes(keys: GranolaKey[], needles: string[][], windowDays: number): Promise<NoteSighting[]> {
  const createdAfter = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const query = `/notes?created_after=${encodeURIComponent(createdAfter)}&page_size=${PAGE_SIZE}`;
  return Promise.all(keys.map(async (key) => {
    try {
      const notes = notesOf(await granola(key.apiKey, query));
      return {
        keyLabel: key.label || "A Granola key",
        error: "",
        // A note `normalizeNote` refused could never have been chosen as a client's call either, so
        // leaving it out keeps this list honest about what was actually in play.
        notes: notes
          .map((raw) => normalizeNote(raw))
          .filter((note): note is GranolaNote => Boolean(note))
          .map((note) => ({ id: note.id, title: note.title, startedAt: note.startedAt, matches: titleMatches(note.title, needles) })),
      };
    } catch (error) {
      return { keyLabel: key.label || "A Granola key", error: error instanceof Error ? error.message : "could not be read.", notes: [] };
    }
  }));
}
