// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The pure half of booked meetings: turning a loose webhook payload into the row we store.
 *
 * The webhook is one Zapier URL used for every client, so the body's shape is whatever the person wiring the
 * Zap mapped — field names vary, casing varies, and half the fields may be absent. This maps that mess onto a
 * fixed set of columns by trying a list of aliases for each, keeps the original string of anything it cannot
 * parse (a date it does not recognise is shown as sent rather than dropped), and stashes the entire payload in
 * `raw` so nothing is ever lost. No I/O, so `tests/meetings.test.mjs` drives it against realistic bodies.
 */

/** Trim a value to a non-empty string, or "" if it is not one. */
function str(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/**
 * The first non-empty value among a set of aliases, matched case- and separator-insensitively.
 *
 * Zapier and Calendly disagree on whether a field is `company_name`, `Company Name`, `companyName` or
 * `company`, so the lookup is done on a normalised key (lowercased, non-alphanumerics stripped) rather than
 * on the exact string the payload happened to use.
 */
function pick(normalized, aliases) {
  for (const alias of aliases) {
    const key = alias.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const value = normalized.get(key);
    if (value) return value;
  }
  return "";
}

/** A flattened, normalised-key view of the payload: every key lowercased with separators stripped. */
function flatten(payload) {
  const map = new Map();
  const walk = (object, prefix) => {
    if (!object || typeof object !== "object") return;
    for (const [rawKey, value] of Object.entries(object)) {
      const key = String(prefix ? `${prefix} ${rawKey}` : rawKey).replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (value && typeof value === "object" && !Array.isArray(value)) {
        walk(value, rawKey); // one level of nesting, so { invitee: { name } } is reachable as "inviteename"
      } else {
        const text = str(value);
        if (text && !map.has(key)) map.set(key, text);
      }
    }
  };
  walk(payload, "");
  return map;
}

/**
 * A start time as an ISO string, or "" if it cannot be parsed.
 *
 * Calendly's own field is ISO and parses cleanly. A human string like "August 19, 2026 @ 10:00 AM EST" does
 * not, because of the "@" — so that is stripped before the attempt, and if it still will not parse the caller
 * keeps the original text to show instead. Never throws.
 */
export function parseWhen(value) {
  const text = str(value);
  if (!text) return "";
  let cleaned = text.replace(/\s+@\s+/, " ");
  if (ZONE_HINT.test(cleaned)) {
    const time = Date.parse(cleaned);
    return Number.isNaN(time) ? "" : new Date(time).toISOString();
  }
  // No zone in the string. Date.parse would read it in the server's own zone (UTC on Vercel), so "10:00 AM"
  // landed as 10:00 UTC, i.e. 6 AM in New York. QC books on Eastern time, so read the wall clock as
  // America/New_York instead. A bare ISO date is parsed as UTC midnight by spec, so give it a time first to
  // keep every zoneless form on the same (local) parsing path.
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) cleaned += "T00:00";
  const local = new Date(Date.parse(cleaned));
  if (Number.isNaN(local.getTime())) return "";
  const wall = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds());
  // Two passes so a time near a DST switch picks up the offset in force at the result, not at the guess.
  const guess = wall - zoneOffsetMs(wall, DEFAULT_ZONE);
  return new Date(wall - zoneOffsetMs(guess, DEFAULT_ZONE)).toISOString();
}

/** The zone a time with no offset is assumed to be in. */
const DEFAULT_ZONE = "America/New_York";

/** An explicit zone or offset in a date string: a trailing Z, +hh:mm / -hhmm, or a name Date.parse knows. */
const ZONE_HINT = /\dZ\b|[+-]\d{2}:?\d{2}\b|\b(?:UTC|UT|GMT|[ECMP][SD]T)\b/i;

/** How far `timeZone`'s wall clock is ahead of UTC at instant `ms`, in milliseconds (negative for New York). */
function zoneOffsetMs(ms, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The statuses a meeting can be in, and the words a webhook might use for each. */
const STATUS_ALIASES = {
  canceled: ["cancel", "canceled", "cancelled", "invitee.canceled"],
  rescheduled: ["reschedule", "rescheduled"],
  completed: ["complete", "completed", "done"],
  no_show: ["noshow", "no_show", "no-show"],
  scheduled: ["schedule", "scheduled", "created", "booked", "active"],
};
function normalizeStatus(value) {
  const key = str(value).replace(/[^a-z]/gi, "").toLowerCase();
  if (!key) return "scheduled";
  for (const [status, aliases] of Object.entries(STATUS_ALIASES)) {
    if (aliases.some((alias) => key.includes(alias.replace(/[^a-z]/gi, "")))) return status;
  }
  return "scheduled";
}

/**
 * A webhook (or manual/assistant) payload mapped onto the meeting columns.
 *
 * Returns `{ client, fields }` — `client` is the routing name pulled out separately because it selects the
 * workspace and is not itself stored, and `fields` is the row. The whole payload rides along in `fields.raw`.
 * @param {Record<string, unknown>} payload
 */
export function normalizeMeeting(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const flat = flatten(body);
  const get = (...aliases) => pick(flat, aliases);
  const dedupeParts = (value) => (typeof value === "string" && value.includes(";") ? [...new Set(value.split(/\s*;\s*/).map((part) => part.trim()).filter(Boolean))].join(", ") : value);

  const whenRaw = get(
    "meeting_at", "meeting_date", "meeting_datetime", "meeting_date_time", "meeting_time",
    "start_time", "startTime", "start", "start_date", "start_datetime",
    "scheduled_at", "scheduled_time", "invitee_start_time", "event_start_time", "event_date",
    "datetime", "date_time", "date", "time", "when",
  );
  const meetingAt = parseWhen(whenRaw);

  return {
    client: get("client", "client_name", "workspace", "account"),
    fields: {
      // The same Zap joins two copies of the name too ("Jane Doe; Jane Doe", "Jane Doe;"): keep it once.
      invitee_name: dedupeParts(get("invitee_name", "name", "invitee", "lead_name", "full_name", "attendee")),
      invitee_email: get("invitee_email", "email", "lead_email"),
      invitee_linkedin: get("invitee_linkedin", "linkedin", "lead_linkedin", "linkedin_url", "person_linkedin"),
      // The booking flow joins two copies of the title with ";" ("CPO ; CPO"); keep each distinct part once.
      invitee_title: dedupeParts(get("invitee_title", "title", "lead_title", "job_title")),
      invitee_location: get("invitee_location", "lead_location", "person_location", "location"),
      invitee_headline: get("invitee_headline", "lead_headline", "headline"),
      company_name: dedupeParts(get("company_name", "company", "organization")),
      company_domain: get("company_domain", "domain", "website"),
      company_linkedin: get("company_linkedin", "company_linkedin_url"),
      company_location: get("company_location"),
      company_industry: get("company_industry", "industry"),
      company_size: get("company_size", "employees", "company_employees"),
      company_type: get("company_type"),
      company_description: get("company_description", "company_summary", "about"),
      meeting_at: meetingAt || null,
      when_text: whenRaw || null,
      summary: get("summary", "event_type", "event_name", "meeting_summary", "meeting_type"),
      host: get("host", "meeting_with", "owner", "assigned_to", "rep"),
      campaign: get("campaign", "campaign_name"),
      status: normalizeStatus(get("status", "event", "invitee_status")),
      external_id: get("external_id", "calendly_event_id", "event_id", "event_uuid", "uuid", "uri", "invitee_uri"),
      raw: body,
    },
  };
}

/** Whether a normalized meeting has enough to be worth storing — a name or an email at least. */
export function meetingIsUsable(fields) {
  return Boolean(str(fields?.invitee_name) || str(fields?.invitee_email) || str(fields?.company_name));
}
