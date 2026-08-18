// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Which Granola meeting is this client's weekly call.
 *
 * ── Why the title, and not the attendee list ─────────────────────────────────────────────────────
 * This matched on attendee email domains first, on the reasoning that who was in the room is more stable
 * than what somebody called the invite. That reasoning was sound and the implementation could not work:
 * Granola's `GET /v1/notes` returns `NoteSummary`, which is `created_at`, `id`, `object`, `owner`,
 * `title`, `updated_at` — and nothing else. Attendees exist only on `GET /v1/notes/{id}`, there is no
 * `include=attendees` on the list, so domain matching costs one extra request per note. Thirty notes per
 * key across ten keys is three hundred requests against a sustained limit of five a second, inside a
 * sixty-second function ceiling that also has a model call in it. It does not fit.
 *
 * The title is in the list response, so matching on it costs nothing. Our invites are named to a
 * convention that carries the client: "QC <> Bluevia Weekly", "Cotool <> QC Weekly", "Steadywell <> QC
 * Weekly", "QC - Willow Weekly Team Sync". The exposure is that a renamed invite loses the call, which
 * shows up as "no call found" in the brief — visible, and fixable from the config page. The exposure of
 * the alternative was every brief timing out.
 *
 * ── Words, not substrings ────────────────────────────────────────────────────────────────────────
 * Matching is on whole words, because substring matching is how a client called "Ema" claims every
 * meeting with "Email" in the title. Both sides are cut into words on any non-alphanumeric character,
 * which is also what makes "<>", ":", "-" and "Willow's" all match without a rule each.
 *
 * ── Why this file imports nothing ────────────────────────────────────────────────────────────────
 * Same reason as `morning-brief.ts`: the tests import it directly, and Node's TypeScript test loader
 * will not resolve extensionless relative imports. Everything that makes an HTTP request is in
 * `granola.ts`. What is here is the decision about which meeting belongs to which client, which is the
 * part that would go wrong quietly — the wrong client's call in a brief is worse than no call at all.
 */

type Row = Record<string, unknown>;

/** A Granola note, reduced to the three things the choice depends on. */
export type GranolaNote = {
  id: string;
  title: string;
  /** Epoch ms, or 0 when the note carried no readable date. */
  startedAt: number;
  summary: string;
};

/**
 * Words that identify nobody.
 *
 * A client's display name is not always what the calendar calls them: the account is "Vitalic Health" and
 * the invite is "QC Growth <> Vitalic Kickoff Pt. 2". Dropping the industry and corporate-form words
 * leaves the part that is actually the company's name, so the common case needs no per-client
 * configuration at all. Kept short on purpose — every word added here is a word that stops
 * distinguishing two clients from each other.
 */
const GENERIC = new Set([
  "health", "healthcare", "medical", "care", "labs", "lab", "tech", "technologies", "technology",
  "software", "systems", "solutions", "digital", "media", "group", "holdings", "ventures", "partners",
  "inc", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "the", "and",
]);

/** Lower-cased words, splitting on anything that is not a letter or a digit. */
function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * What has to appear in a meeting title for it to be this client's call.
 *
 * `configured` is the optional override from the config page, comma separated so a client the calendar
 * names two ways can have both. When it is blank the client's own display name is used, which is why
 * almost nobody needs to fill the field in.
 *
 * A single word of two characters or fewer is dropped: "QC" as a needle matches every meeting we have.
 * Multi-word needles keep every word, because "QC Growth" is only dangerous a word at a time.
 */
export function parseTitleNeedles(configured: unknown, clientName: unknown): string[][] {
  const raw = typeof configured === "string" && configured.trim() ? configured : typeof clientName === "string" ? clientName : "";
  const needles: string[][] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,;/]+/)) {
    const parts = words(part);
    // A one-word needle has to survive on its own, so the generic words come out. A multi-word needle
    // matches as a phrase and "Vitalic Health" is perfectly safe as one.
    const needle = parts.length === 1 ? parts.filter((word) => !GENERIC.has(word) && word.length > 2) : parts;
    if (!needle.length) continue;
    const key = needle.join(" ");
    if (!seen.has(key)) {
      seen.add(key);
      needles.push(needle);
    }
  }
  // "Vitalic Health" should also match an invite that says only "Vitalic", so a multi-word name
  // contributes its distinctive words individually as well as as a phrase.
  for (const needle of [...needles]) {
    if (needle.length < 2) continue;
    for (const word of needle) {
      if (GENERIC.has(word) || word.length <= 2 || seen.has(word)) continue;
      seen.add(word);
      needles.push([word]);
    }
  }
  return needles;
}

/** Whether a title contains any of the needles, each as a run of whole words. */
export function titleMatches(title: unknown, needles: string[][]): boolean {
  const found = words(typeof title === "string" ? title : "");
  return needles.some((needle) =>
    found.some((_, index) => needle.every((word, offset) => found[index + offset] === word)),
  );
}

/** The needles as they read on a page: `Vitalic Health` or `Bluevia`. */
export function describeNeedles(needles: string[][]): string {
  return needles.map((needle) => needle.join(" ")).join(" or ");
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Epoch ms from whichever of the date fields the note actually carried. */
function noteStartedAt(note: Row): number {
  const event = (note.calendar_event ?? note.google_calendar_event ?? {}) as Row;
  // `scheduled_start_time` is what Granola's note detail calls it, and it is the only one of these that is
  // the meeting's own time rather than the time the note was written. `created_at` is last for that
  // reason: it is close enough on the day, and wrong for a note written up afterwards.
  const candidates = [event.scheduled_start_time, note.started_at, note.start_time, note.meeting_date, event.start_time, (event.start as Row)?.dateTime, event.start, note.created_at, note.updated_at];
  for (const candidate of candidates) {
    const parsed = Date.parse(text(candidate));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/** One note as the matcher needs it, or null if it has no id to fetch a transcript with. */
export function normalizeNote(raw: unknown): GranolaNote | null {
  const note = (raw ?? {}) as Row;
  const id = text(note.id) || text(note.note_id) || text(note.document_id);
  if (!id) return null;
  return {
    id,
    title: text(note.title) || text(note.name) || "Untitled meeting",
    startedAt: noteStartedAt(note),
    // Empty from the list endpoint, which returns no summary. Kept because the note fetched for the
    // winning call does carry one.
    summary: text(note.summary_markdown) || text(note.summary) || text(note.overview),
  };
}

/**
 * The most recent meeting whose title names this client, or null.
 *
 * Most recent rather than "the one that looks like the weekly": a kickoff or an ad-hoc escalation call is
 * at least as worth reading as the standing weekly. Notes with no readable date lose to any note that has
 * one, because "the latest call" is the entire claim being made and a note that cannot prove its own date
 * cannot support it.
 */
export function pickLatestCall(notes: unknown[], needles: string[][]): GranolaNote | null {
  if (!needles.length) return null;
  let best: GranolaNote | null = null;
  for (const raw of notes) {
    const note = normalizeNote(raw);
    if (!note || !titleMatches(note.title, needles)) continue;
    if (!best || note.startedAt > best.startedAt) best = note;
  }
  return best;
}

/** How old the call is, in whole days, for a brief that has to say whether it is still current. */
export function callAgeDays(startedAt: number, now = Date.now()): number | null {
  if (!startedAt) return null;
  return Math.max(0, Math.round((now - startedAt) / 86_400_000));
}

/**
 * The transcript as one block of text.
 *
 * Read defensively for the same reason the note fields are: the shape has moved between API versions,
 * and a transcript that arrives as speaker-tagged segments is more useful with the tags kept than
 * flattened, so both shapes are handled rather than one being assumed.
 */
export function transcriptText(payload: unknown): string {
  if (typeof payload === "string") return payload.trim();
  const body = (payload ?? {}) as Row;
  for (const key of ["transcript", "text", "content", "body"]) {
    if (typeof body[key] === "string") return (body[key] as string).trim();
  }
  const segments = [body.segments, body.transcript, body.utterances, body.data, Array.isArray(payload) ? payload : null].find(Array.isArray) as unknown[] | undefined;
  if (!segments) return "";
  return segments
    .map((raw) => {
      if (typeof raw === "string") return raw;
      const segment = (raw ?? {}) as Row;
      const speaker = String(segment.speaker ?? segment.source ?? segment.name ?? "").trim();
      const said = String(segment.text ?? segment.content ?? segment.value ?? "").trim();
      if (!said) return "";
      return speaker ? `${speaker}: ${said}` : said;
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}
