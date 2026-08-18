// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * When a scheduled brief is due, and whether a client is in a fit state to receive one.
 *
 * ── Both halves are here because both are silent when wrong ──────────────────────────────────────
 * A schedule that is an hour out sends Monday's brief on Sunday night, and nobody reports it as a bug —
 * they just stop trusting the timing. A readiness check that is too generous posts a brief built from
 * two sources while the page claims three. Neither failure raises an error, so both are computed here,
 * with no imports, so the tests can run them directly.
 *
 * ── Time zones are done with Intl, not arithmetic ────────────────────────────────────────────────
 * "Eight in the morning Eastern" is not a fixed offset from UTC — it is four hours in summer and five in
 * winter. Anything that stores an offset gets the week of the clock change wrong in one direction and
 * the following March wrong in the other. `Intl.DateTimeFormat` is the only thing in the platform that
 * knows the rules, so the local day and the local clock time are both read out of it.
 */

/** How stale HeyReach figures may be before a client counts as not reporting. Two days of cycles. */
export const STALE_POLL_HOURS = 48;

/** JavaScript's own day numbering, so this can be compared against `getUTCDay()` with nothing between. */
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type BriefSchedule = {
  enabled: boolean;
  /** 0 is Sunday. */
  sendDays: number[];
  sendHour: number;
  sendMinute: number;
  timezone: string;
  destination: string;
};

export const DEFAULT_SCHEDULE: BriefSchedule = {
  enabled: false,
  sendDays: [1, 3, 5],
  sendHour: 8,
  sendMinute: 0,
  timezone: "America/New_York",
  // Not 'internal'. A freshly enabled automation posts where only the team is looking until somebody
  // moves it, so the first scheduled run of a misjudged prompt cannot reach a client-facing channel.
  destination: "test",
};

/** The calendar date in a given zone, as `YYYY-MM-DD`. `en-CA` formats in that order by definition. */
export function localDayKey(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    // An unknown zone must not stop briefs going out entirely, so this falls back to UTC and the
    // schedule runs an hour or two off rather than never.
    return date.toISOString().slice(0, 10);
  }
}

/** Minutes since local midnight in a given zone. */
export function localMinutes(date: Date, timeZone: string): number {
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

/** Which day of the week the local date falls on, 0 for Sunday. */
export function localWeekday(date: Date, timeZone: string): number {
  return new Date(`${localDayKey(date, timeZone)}T00:00:00Z`).getUTCDay();
}

/**
 * Whether the schedule says a brief should have gone out by now, today.
 *
 * Deliberately "should have gone out by now" rather than "is it exactly eight o'clock". The worker wakes
 * every couple of minutes and a deploy, a restart or a slow cycle can easily mean it is not awake at
 * 08:00 — and a brief that silently skips a day because the worker blinked is worse than one that lands
 * at 08:40. The "already sent today" check is what stops this from sending repeatedly all morning, and
 * that check reads the log rather than a variable, so a restart cannot double-post either.
 */
export function isDueNow(schedule: BriefSchedule, now = new Date()): boolean {
  if (!schedule.enabled) return false;
  if (!schedule.sendDays.includes(localWeekday(now, schedule.timezone))) return false;
  return localMinutes(now, schedule.timezone) >= schedule.sendHour * 60 + schedule.sendMinute;
}

/** Whether a brief has already been sent to this client today, in the schedule's own zone. */
export function alreadySentToday(lastSentAt: string | null | undefined, schedule: BriefSchedule, now = new Date()): boolean {
  if (!lastSentAt) return false;
  const sent = new Date(lastSentAt);
  if (Number.isNaN(sent.getTime())) return false;
  return localDayKey(sent, schedule.timezone) === localDayKey(now, schedule.timezone);
}

export type ReadinessInput = {
  heyreachKeyConfigured: boolean;
  lastSuccessfulPollAt: string | null;
  internalChannelId: string;
  externalChannelId: string;
  granolaTitleMatch: string;
  granolaKeyCount: number;
};

export type Check = { ok: boolean; detail: string };
export type Readiness = { heyreach: Check; slack: Check; granola: Check; ready: boolean };

/**
 * The three sources, each either working or with a reason it is not.
 *
 * A brief can be written with one source missing and often should be — but the page must say so, because
 * a brief that quietly stops reading the client's call still reads like a complete brief. That is the
 * failure this exists to make visible.
 */
export function readinessOf(input: ReadinessInput, now = Date.now()): Readiness {
  const pollAge = input.lastSuccessfulPollAt ? (now - Date.parse(input.lastSuccessfulPollAt)) / 3_600_000 : null;
  const heyreach: Check = !input.heyreachKeyConfigured
    ? { ok: false, detail: "No HeyReach key" }
    : pollAge === null || !Number.isFinite(pollAge)
      ? { ok: false, detail: "Never polled" }
      : pollAge > STALE_POLL_HOURS
        ? { ok: false, detail: `Last polled ${Math.round(pollAge)}h ago` }
        : { ok: true, detail: pollAge < 1 ? "Polling now" : `Polled ${Math.round(pollAge)}h ago` };

  // Internal is the one that matters: it is where the team's commitments are, and where a brief posts.
  // A missing external channel costs the brief one section, so it is a note rather than a failure.
  const slack: Check = !input.internalChannelId
    ? { ok: false, detail: "No internal channel" }
    : input.externalChannelId
      ? { ok: true, detail: "Both channels set" }
      : { ok: true, detail: "Internal only" };

  const granola: Check = !input.granolaKeyCount
    ? { ok: false, detail: "No Granola keys added" }
    : !input.granolaTitleMatch.trim()
      ? { ok: false, detail: "No name to match titles on" }
      : { ok: true, detail: `${input.granolaKeyCount === 1 ? "1 key" : `${input.granolaKeyCount} keys`} · matching “${input.granolaTitleMatch.trim()}”` };

  // Slack alone decides whether a brief can be *sent*, because without a channel there is nowhere to put
  // it. The other two decide how good it will be. `ready` means all three, which is what the grid shows.
  return { heyreach, slack, granola, ready: heyreach.ok && slack.ok && granola.ok };
}

/** "Mon, Wed and Fri at 8:00 AM" — the schedule as a sentence, for the one line above the controls. */
export function describeSchedule(schedule: BriefSchedule): string {
  const days = [...schedule.sendDays].sort((a, b) => a - b).map((day) => DAY_NAMES[day]?.slice(0, 3)).filter(Boolean);
  const when = days.length === 7 ? "Every day" : days.length ? days.join(", ") : "No days selected";
  const hour = schedule.sendHour % 12 === 0 ? 12 : schedule.sendHour % 12;
  const suffix = schedule.sendHour < 12 ? "AM" : "PM";
  return `${when} at ${hour}:${String(schedule.sendMinute).padStart(2, "0")} ${suffix} ${schedule.timezone.split("/").pop()?.replace(/_/g, " ") ?? schedule.timezone}`;
}
