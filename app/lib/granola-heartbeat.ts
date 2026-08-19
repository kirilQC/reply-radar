// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Granola heartbeat: when the worker should ask Granola what calls it can see, and whether the last
 * answer is recent enough to call the connection healthy.
 *
 * ── Why there is a window at all ─────────────────────────────────────────────────────────────────
 * A weekly client call happens in working hours, so asking Granola what is new at three in the morning
 * only spends the rate limit to learn nothing. The window is 5am to 8pm Eastern, seven days a week —
 * wide enough that a call finished at any plausible hour is picked up within the hour, narrow enough that
 * the overnight silence is understood as "not looking" rather than "broken."
 *
 * ── Why "down" is only judged inside the window ──────────────────────────────────────────────────
 * Outside the window the worker deliberately does not poll, so the last heartbeat is naturally hours old
 * by dawn. Calling that "down" would paint the health page red every single night for a system that is
 * working exactly as designed. So staleness is only a fault while the window is open: inside it, a gap of
 * more than six hours means the hourly poll has silently stopped and somebody should look.
 *
 * ── Why it is pure ───────────────────────────────────────────────────────────────────────────────
 * The same split the rest of the codebase keeps: the clock arithmetic and the verdict have no I/O and no
 * relative value imports, so a test can wind the clock to 4:59am or to a six-hour-old heartbeat and assert
 * the verdict without a Granola key or a database. The poll itself, and the row it writes, live in the
 * route and the worker.
 */

/** The heartbeat's window and zone. Eastern, because that is where the team and the calls are. */
export const GRANOLA_TIMEZONE = "America/New_York";
/** 5:00am local, in minutes since midnight — the first minute the window is open. */
export const GRANOLA_WINDOW_START_MINUTE = 5 * 60;
/** 8:00pm local, in minutes since midnight — the last minute the window is open. */
export const GRANOLA_WINDOW_END_MINUTE = 20 * 60;
/** How stale the last in-window heartbeat may be before the connection is called down. */
export const GRANOLA_DOWN_SECONDS = 6 * 60 * 60;

/**
 * Minutes since local midnight in a zone, read out of Intl so the window follows the clock through both
 * daylight-saving changes rather than an offset that is wrong for two weeks a year. Inlined rather than
 * imported so this file keeps no relative value imports and stays testable on its own.
 */
function localMinutes(date: Date, timeZone: string): number {
  try {
    const [hour, minute] = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false })
      .format(date)
      .split(":")
      .map(Number);
    return hour * 60 + minute;
  } catch {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }
}

/** Whether the heartbeat window is open right now — 5:00am to 8:00pm inclusive, in the heartbeat's zone. */
export function inGranolaWindow(now: Date = new Date(), timeZone: string = GRANOLA_TIMEZONE): boolean {
  const minutes = localMinutes(now, timeZone);
  return minutes >= GRANOLA_WINDOW_START_MINUTE && minutes <= GRANOLA_WINDOW_END_MINUTE;
}

/**
 * The four states the heartbeat can be in, from the last stored check and the current clock.
 *
 *   idle     — outside the window; not polling on purpose, so nothing is wrong.
 *   starting — inside the window but no heartbeat has ever been stored; the first poll is still to come.
 *   ok       — inside the window and the last heartbeat is fresher than the six-hour ceiling.
 *   down     — inside the window and the last heartbeat is older than six hours: the poll has stalled.
 */
export type GranolaHeartbeatState = "idle" | "starting" | "ok" | "down";

export function granolaHeartbeatState(
  input: { lastCheckedAt: string | null | undefined; now?: Date; timeZone?: string; downSeconds?: number },
): { state: GranolaHeartbeatState; inWindow: boolean; ageSeconds: number | null } {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? GRANOLA_TIMEZONE;
  const downSeconds = input.downSeconds ?? GRANOLA_DOWN_SECONDS;
  const inWindow = inGranolaWindow(now, timeZone);

  const stamp = input.lastCheckedAt ? Date.parse(input.lastCheckedAt) : NaN;
  const ageSeconds = Number.isFinite(stamp) ? Math.max(0, Math.floor((now.getTime() - stamp) / 1000)) : null;

  if (!inWindow) return { state: "idle", inWindow, ageSeconds };
  if (ageSeconds === null) return { state: "starting", inWindow, ageSeconds };
  return { state: ageSeconds > downSeconds ? "down" : "ok", inWindow, ageSeconds };
}

/** One client's place in a heartbeat: the call the poll found for them, or null when none matched. */
export type HeartbeatSighting = {
  slug: string;
  name: string;
  noteId: string | null;
  title: string | null;
  startedAt: number | null;
  ageDays: number | null;
  owner: string | null;
  /** True when this call has not yet been posted to Slack — the trigger the worker acts on. */
  isNew: boolean;
};

/**
 * Which of the found calls are new, i.e. worth posting.
 *
 * A call is new when a call was found for the client and its Granola note id is not already in the set of
 * ids that have been posted. Keyed on the note id, not the day, so re-running the poll on the same call an
 * hour later does not post it twice and a second call in the same week is still caught.
 */
export function selectNewCalls(
  sightings: Array<{ slug: string; noteId: string | null }>,
  postedNoteIds: Set<string>,
): string[] {
  return sightings
    .filter((sighting) => sighting.noteId && !postedNoteIds.has(sighting.noteId))
    .map((sighting) => sighting.slug);
}
