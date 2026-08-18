// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Which Granola meeting is this client's weekly call.
 *
 * ── Why the attendee list and not the title ──────────────────────────────────────────────────────
 * Our meeting titles do not contain our clients' names. Willow's weekly is "QC - Willow Weekly Team
 * Sync" and the account is Webrix; Bluevia's is "QC <> Bluevia Weekly"; Cotool's is "Cotool <> QC
 * Weekly". Matching on titles would need a per-client string that breaks the first time somebody
 * renames a calendar invite — and people rename calendar invites. Who was in the room does not change,
 * so the client's own email domain is the stable key.
 *
 * ── Why this file imports nothing ────────────────────────────────────────────────────────────────
 * Same reason as `morning-brief.ts`: the tests import it directly, and Node's TypeScript test loader
 * will not resolve extensionless relative imports. Everything that makes an HTTP request is in
 * `granola.ts`. What is here is the decision about which meeting belongs to which client, which is the
 * part that would go wrong quietly — the wrong client's call in a brief is worse than no call at all.
 */

type Row = Record<string, unknown>;

/** A Granola note, reduced to the four things the choice depends on. */
export type GranolaNote = {
  id: string;
  title: string;
  /** Epoch ms, or 0 when the note carried no readable date. */
  startedAt: number;
  /** Lower-cased email domains of everyone Granola knows was there. */
  domains: string[];
  summary: string;
};

/**
 * The client's domains as configured, one per client, comma or whitespace separated.
 *
 * A pasted address works as well as a bare domain — somebody will paste `eyal@webrix.ai` — so anything
 * before an `@` is dropped rather than treated as part of the domain.
 */
export function parseDomains(raw: unknown): string[] {
  const text = typeof raw === "string" ? raw : "";
  const seen = new Set<string>();
  for (const part of text.split(/[,;\s]+/)) {
    const domain = part.trim().toLowerCase().replace(/^.*@/, "").replace(/^\.+|\.+$/g, "");
    // Two labels minimum, so a stray "qc" or "weekly" cannot match every meeting in the account.
    if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) seen.add(domain);
  }
  return [...seen];
}

const EMAIL = /[a-z0-9._%+-]+@([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi;

/**
 * Every email domain named anywhere in the attendee metadata.
 *
 * Granola's note object is read defensively on purpose. The public API returns attendees, but the exact
 * nesting has changed across versions and is different again from what the MCP connector reports, so
 * rather than commit to one path this sweeps the plausible ones for anything shaped like an address.
 * The sweep is deliberately kept away from the summary and the transcript: an address quoted in the body
 * of a call ("I'll email fred@othercompany.com") is not evidence of who attended, and treating it as
 * such is how one client's call would end up in another client's brief.
 */
export function noteDomains(raw: unknown): string[] {
  const note = (raw ?? {}) as Row;
  const holders = [note.attendees, note.participants, note.people, note.invitees, (note.calendar_event as Row)?.attendees, (note.google_calendar_event as Row)?.attendees];
  const found = new Set<string>();
  for (const holder of holders) {
    if (!holder) continue;
    for (const match of JSON.stringify(holder).matchAll(EMAIL)) found.add(match[1].toLowerCase());
  }
  return [...found];
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** Epoch ms from whichever of the date fields the note actually carried. */
function noteStartedAt(note: Row): number {
  const event = (note.calendar_event ?? note.google_calendar_event ?? {}) as Row;
  const candidates = [note.started_at, note.start_time, note.meeting_date, event.start_time, (event.start as Row)?.dateTime, event.start, note.created_at, note.updated_at];
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
    domains: noteDomains(note),
    summary: text(note.summary_markdown) || text(note.summary) || text(note.overview),
  };
}

/**
 * The most recent meeting that one of this client's people was in, or null.
 *
 * Most recent rather than "the one titled like a weekly": a kickoff or an ad-hoc escalation call is at
 * least as worth reading as the standing weekly, and filtering on the title would drop it. Notes with no
 * readable date lose to any note that has one, because "the latest call" is the entire claim being made
 * and a note that cannot prove its own date cannot support it.
 */
export function pickLatestCall(notes: unknown[], domains: string[]): GranolaNote | null {
  if (!domains.length) return null;
  const wanted = new Set(domains);
  let best: GranolaNote | null = null;
  for (const raw of notes) {
    const note = normalizeNote(raw);
    if (!note || !note.domains.some((domain) => wanted.has(domain))) continue;
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
