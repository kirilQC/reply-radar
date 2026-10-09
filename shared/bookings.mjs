// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Booking alerts, the pure half: reading a Calendly or cal.com webhook, deciding which client a booking is
 * for, reading what Clay sends back, and laying out the Slack card and its two thread replies. No I/O, so
 * tests/bookings.test.mjs drives it with real payload shapes. The order things happen in is
 * app/lib/booking-run.ts.
 *
 * The layout copies the per-client Zaps it replaces ("A new booking has been scheduled!", then LEAD INFO /
 * COMPANY INFO, then TLDR in the thread), so the channels look the same the day the Zaps are switched off.
 */

import { stripDashes } from "./no-dashes.mjs";

const str = (value) => (typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : "");
const obj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

/** Values Clay and the booking forms use for "nothing here". The Zaps' own isInvalid helper skipped these. */
const EMPTY_WORDS = new Set(["null", "undefined", "none", "n/a", "na", "-", "[]", "{}", "false", "unknown", "not found", "no data"]);
export function clean(value) {
  const text = str(value);
  return EMPTY_WORDS.has(text.toLowerCase()) ? "" : text;
}

// ── Booking forms ─────────────────────────────────────────────────────────────────────────────────

const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|zoho|yandex|hey|fastmail|comcast|verizon|att|sbcglobal)\./i;

/** The company domain out of a work email, or "" for a personal address. */
export function workDomain(email) {
  const text = str(email).toLowerCase();
  if (!text.includes("@") || FREE_MAIL.test(text)) return "";
  return text.split("@")[1] || "";
}

/** The first linkedin.com URL in a value, cleaned of Clay prefixes ("THIS-ONEhttps://…") and tracking. */
export function linkedinUrl(value) {
  const match = str(value).match(/(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|company|pub)\/[^\s"'<>|,]+/i);
  if (!match) return "";
  const url = match[0].replace(/^(?!https?:\/\/)/i, "https://").replace(/[?#].*$/, "").replace(/\/+$/, "");
  return url;
}

/**
 * Title, company and LinkedIn out of a booking form's questions, matched on the question's wording.
 *
 * Every client's form asks in its own words ("Job title", "What's your role?", "Company name"), so this reads
 * the question rather than its position. A long free-text answer is never taken as a company name.
 * @param {Array<{question?: string, answer?: string}>} answers
 */
export function answersToFields(answers) {
  const out = { title: "", company: "", linkedin: "" };
  for (const item of Array.isArray(answers) ? answers : []) {
    const question = str(item?.question ?? item?.label).toLowerCase();
    const answer = clean(item?.answer ?? item?.value);
    if (!question || !answer) continue;
    if (!out.linkedin && /linked\s*in/.test(question)) { out.linkedin = linkedinUrl(answer) || answer; continue; }
    if (!out.title && /\b(title|role|position|job)\b/.test(question)) { out.title = answer; continue; }
    if (!out.company && /\b(company|organi[sz]ation|employer|business|practice|agency|firm|institution)\b/.test(question) && answer.length <= 80) out.company = answer;
  }
  return out;
}

/** First names of the people the meeting is with, our own team left out: "Josh & Tim". */
export function hostsLabel(people, ownDomain = "qcgrowth.com") {
  const names = [];
  for (const person of Array.isArray(people) ? people : []) {
    const email = str(person?.user_email ?? person?.email).toLowerCase();
    if (ownDomain && email.endsWith(`@${ownDomain}`)) continue;
    const first = str(person?.user_name ?? person?.name).split(/\s+/)[0];
    if (first && !names.includes(first)) names.push(first);
  }
  return names.join(" & ");
}

/** "September 02, 2026 @ 2:00 PM EDT", the Zaps' format, in New York time. */
export function formatMeetingTime(iso, timeZone = "America/New_York") {
  const date = new Date(str(iso));
  if (Number.isNaN(date.getTime())) return str(iso);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, month: "long", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.month} ${parts.day}, ${parts.year} @ ${parts.hour}:${parts.minute} ${parts.dayPeriod} ${parts.timeZoneName}`;
}

/**
 * A Calendly webhook (v2) read into one shape.
 *
 * A reschedule arrives as two events: `invitee.canceled` with `rescheduled: true` for the old time, and
 * `invitee.created` carrying `old_invitee` for the new one. The cancel is ignored and the create moves the
 * existing meeting, so a reschedule is one meeting with a new time rather than a cancel plus a duplicate.
 */
export function parseCalendly(body) {
  const root = obj(body);
  const event = str(root.event);
  const p = obj(root.payload);
  const scheduled = obj(p.scheduled_event);
  const form = answersToFields(p.questions_and_answers);
  const email = str(p.email);
  const kind = event === "invitee.created" ? "created" : event === "invitee.canceled" ? (p.rescheduled ? "ignored" : "canceled") : "ignored";
  const start = str(scheduled.start_time);
  return {
    kind,
    eventName: str(scheduled.name),
    // The event type's own id: what a client's chosen events are matched on, since a name can repeat.
    eventTypeId: str(scheduled.event_type),
    externalId: str(p.uri),
    previousId: kind === "created" ? str(p.old_invitee) : "",
    fields: {
      invitee_name: str(p.name) || [str(p.first_name), str(p.last_name)].filter(Boolean).join(" "),
      invitee_email: email,
      invitee_title: form.title,
      invitee_linkedin: form.linkedin,
      company_name: form.company,
      company_domain: workDomain(email),
      meeting_at: start || null,
      when_text: start ? formatMeetingTime(start) : "",
      summary: str(scheduled.name),
      host: hostsLabel(scheduled.event_memberships),
      status: kind === "canceled" ? "canceled" : "scheduled",
    },
  };
}

/** A cal.com webhook read into the same shape. `rescheduleUid` names the booking a reschedule replaces. */
export function parseCalCom(body) {
  const root = obj(body);
  const trigger = str(root.triggerEvent).toUpperCase();
  const p = obj(root.payload);
  const attendee = obj((Array.isArray(p.attendees) ? p.attendees : [])[0]);
  const responses = obj(p.responses);
  const answers = Object.entries(responses).map(([key, value]) => {
    const field = obj(value);
    return { question: str(field.label) || key, answer: typeof field.value === "string" ? field.value : str(value) };
  });
  const form = answersToFields(answers);
  const email = str(attendee.email) || str(obj(responses.email).value);
  const kind = trigger === "BOOKING_CREATED" || trigger === "BOOKING_RESCHEDULED" ? "created" : trigger === "BOOKING_CANCELLED" ? "canceled" : "ignored";
  const start = str(p.startTime);
  const hosts = [obj(p.organizer), ...(Array.isArray(obj(p.team).members) ? obj(p.team).members : [])];
  const eventName = str(p.eventTitle) || str(p.type) || str(p.title);
  return {
    kind,
    eventName: [str(p.eventTitle), str(p.type), str(p.title)].filter(Boolean).join(" · ") || eventName,
    eventTypeId: p.eventTypeId === undefined || p.eventTypeId === null ? "" : str(p.eventTypeId),
    externalId: str(p.uid),
    previousId: trigger === "BOOKING_RESCHEDULED" ? str(p.rescheduleUid) || str(p.fromReschedule) : "",
    fields: {
      invitee_name: str(attendee.name) || str(obj(responses.name).value),
      invitee_email: email,
      invitee_title: form.title,
      invitee_linkedin: form.linkedin,
      company_name: form.company,
      company_domain: workDomain(email),
      meeting_at: start || null,
      when_text: start ? formatMeetingTime(start) : "",
      summary: eventName,
      host: hostsLabel(hosts),
      status: kind === "canceled" ? "canceled" : "scheduled",
    },
  };
}

// ── Which client ──────────────────────────────────────────────────────────────────────────────────

/** A client's event-name filter as terms. Blank means the client's own name, which is what every Zap filtered on. */
export function filterTerms(filter, clientName) {
  const terms = str(filter).split(",").map((term) => term.trim().toLowerCase()).filter(Boolean);
  if (terms.length) return terms;
  const name = str(clientName).toLowerCase();
  return name ? [name] : [];
}

/** The longest term of `terms` the event name contains, or "" for none. */
export function matchedTerm(eventName, terms) {
  const name = str(eventName).toLowerCase();
  let best = "";
  for (const term of terms) if (term && name.includes(term) && term.length > best.length) best = term;
  return best;
}

/**
 * The client a booking on the shared QC calendar belongs to, by event-type name.
 *
 * Several clients book through the same Calendly, so the event name ("Steadywell Intro") is the only thing
 * that says whose meeting it is. The most specific match wins ("Ema Health" beats "Ema"); two clients
 * matching equally is ambiguous and returns null rather than guess, because a booking in the wrong client's
 * channel is worse than none.
 * @param {string} eventName
 * @param {Array<{id: string, name: string, filter?: string}>} clients
 */
export function routeBooking(eventName, clients) {
  let best = null;
  let bestLength = 0;
  let tie = false;
  for (const client of Array.isArray(clients) ? clients : []) {
    const term = matchedTerm(eventName, filterTerms(client.filter, client.name));
    if (!term) continue;
    if (term.length > bestLength) { best = client; bestLength = term.length; tie = false; }
    else if (term.length === bestLength) tie = true;
  }
  return tie ? null : best;
}

/**
 * Whether a booking on a client's own calendar is one of the events that runs the workflow.
 *
 * A client's Calendly holds all their own meetings as well as the one QC created for them ("QC Growth
 * Meeting"), so only the event types chosen on the Booked meetings page count, matched on the event type's
 * id. With none chosen nothing counts: posting a client's internal meetings would be worse than posting none.
 * A legacy name filter still works for a client set up before event types could be chosen.
 * @param {{ eventTypeId?: string, eventName?: string }} parsed
 * @param {Array<{ id: string, name?: string }>} chosen
 * @param {string} [legacyFilter]
 */
export function eventChosen(parsed, chosen, legacyFilter = "") {
  const list = Array.isArray(chosen) ? chosen : [];
  if (list.length) {
    const id = str(parsed?.eventTypeId);
    if (id && list.some((event) => str(event.id) === id)) return true;
    // An event type id missing from the payload (rare) falls back to the exact chosen name.
    const name = str(parsed?.eventName).toLowerCase();
    return !id && Boolean(name) && list.some((event) => name.includes(str(event.name).toLowerCase()) && str(event.name));
  }
  const terms = str(legacyFilter).split(",").map((term) => term.trim().toLowerCase()).filter(Boolean);
  return terms.length > 0 && Boolean(matchedTerm(parsed?.eventName, terms));
}

// ── Clay ──────────────────────────────────────────────────────────────────────────────────────────

/** Every key at any depth, lowercased with separators stripped, first non-empty value kept. */
function flatten(payload) {
  const map = new Map();
  const walk = (value, depth) => {
    if (depth > 4 || !value || typeof value !== "object") return;
    for (const [rawKey, inner] of Object.entries(value)) {
      if (inner && typeof inner === "object" && !Array.isArray(inner)) { walk(inner, depth + 1); continue; }
      const key = rawKey.replace(/[^a-z0-9]/gi, "").toLowerCase();
      const text = Array.isArray(inner) ? inner.map((item) => clean(item)).filter(Boolean).join(", ") : clean(inner);
      if (text && !map.has(key)) map.set(key, text);
    }
  };
  walk(payload, 0);
  return map;
}
const pick = (flat, aliases) => {
  for (const alias of aliases) {
    const value = flat.get(alias.replace(/[^a-z0-9]/gi, "").toLowerCase());
    if (value) return value;
  }
  return "";
};

/** A bare number of employees reads as "195 employees". Ranges and words are kept as Clay wrote them. */
function sizeLabel(value) {
  const text = str(value);
  return /^\d[\d,]*$/.test(text) ? `${Number(text.replace(/,/g, "")).toLocaleString("en-US")} employees` : text;
}

/**
 * What Clay's HTTP API column posts back, read into meeting columns plus the four TLDR fields.
 *
 * Clay's column names are whatever the table calls them, so each field takes a list of likely names, matched
 * ignoring case and separators. `meeting_id` is the row's own id that QC sent in, and is the only field that
 * has to come back exactly.
 */
export function fromClay(body) {
  const flat = flatten(obj(body));
  const get = (...aliases) => pick(flat, aliases);
  const testValue = get("test", "is_test").toLowerCase();
  return {
    meetingId: get("meeting_id", "meetingid", "qc_meeting_id", "booking_id"),
    test: testValue === "true" || testValue === "1" || testValue === "yes",
    fields: {
      invitee_name: get("lead_name", "full_name", "person_name", "name"),
      invitee_email: get("lead_email", "work_email", "person_email", "email"),
      invitee_linkedin: linkedinUrl(get("lead_linkedin", "USER LINKEDIN FINAL!!", "linkedin", "linkedin_url", "person_linkedin", "linkedin_profile", "linkedin_profile_url", "spark_linkedin")),
      invitee_title: get("lead_title", "title", "job_title", "person_title"),
      invitee_location: get("lead_location", "person_location", "location_name", "location"),
      invitee_headline: get("lead_headline", "headline", "headline_2", "person_headline"),
      invitee_photo_url: get("lead_photo", "profile_photo", "profile_picture", "photo_url"),
      company_name: get("company_name", "company"),
      company_domain: get("company_domain", "domain", "company_website", "website").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/.*$/, ""),
      company_linkedin: linkedinUrl(get("company_linkedin", "company_linkedin_url")),
      company_location: get("company_location", "company_hq", "hq", "company_headquarters", "locality"),
      company_industry: get("company_industry", "industry"),
      company_size: sizeLabel(get("company_size", "company_headcount", "headcount", "employees", "employee_count")),
      company_type: get("company_type"),
      company_description: get("company_description", "description_2", "company_about", "about", "description"),
      company_logo_url: get("company_logo", "company_logo_url", "logo_url", "logo"),
    },
    tldr: {
      leadSummary: get("lead_summary", "person_summary"),
      companySummary: get("company_summary"),
      callFocus: get("call_focus", "pre_call_focus"),
      painPoints: get("pain_points"),
      leadCallFocus: get("lead_call_focus", "person_call_focus"),
      companyCallFocus: get("company_call_focus"),
    },
  };
}

/** Whether a TLDR has anything in it. */
export const hasTldr = (tldr) => Boolean(tldr && Object.values(tldr).some((value) => str(value)));

// ── Slack layout ──────────────────────────────────────────────────────────────────────────────────

/** Slack's three control characters, escaped so a name with "<" cannot become a mention or a link. */
export const esc = (value) => str(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** What every Slack-bound value goes through: no dashes, escaped. */
const out = (value) => esc(stripDashes(clean(value)));
const link = (url, label) => {
  const href = str(url);
  if (!href) return "";
  const full = /^https?:\/\//i.test(href) ? href : `https://${href}`;
  return `<${full.replace(/[<>|]/g, "")}|${esc(label || href)}>`;
};

/** A mrkdwn section, split at Slack's 3,000 character limit on a line break. */
function sections(text) {
  const blocks = [];
  let rest = text;
  while (rest.length > 2900) {
    const cut = rest.lastIndexOf("\n", 2900) > 1000 ? rest.lastIndexOf("\n", 2900) : 2900;
    blocks.push({ type: "section", expand: true, text: { type: "mrkdwn", text: rest.slice(0, cut) } });
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  // expand: Slack otherwise folds a long section behind "Show more"; the post always arrives open.
  if (rest.trim()) blocks.push({ type: "section", expand: true, text: { type: "mrkdwn", text: rest } });
  return blocks;
}

/**
 * The card in the channel. `meeting` uses the rr_meetings column names.
 * @param {Record<string, unknown>} meeting
 * @param {{ test?: boolean, rescheduledFrom?: string, meetingNumber?: number }} [opts]
 */
export function buildBookingCard(meeting, opts = {}) {
  const m = obj(meeting);
  const when = clean(m.meeting_at) ? formatMeetingTime(m.meeting_at) : clean(m.when_text);
  const canceled = str(m.status) === "canceled";
  const heading = canceled ? "*This booking was canceled.*" : opts.rescheduledFrom ? "*This booking was rescheduled.*" : "*A new booking has been scheduled!*";
  const lines = [
    ["Time", out(when ? (canceled ? `~${when}~` : when) : "")],
    ["Summary", out(m.summary)],
    ["Name", out(m.invitee_name)],
    ["Company", out(m.company_name)],
    ["Title", out(m.invitee_title)],
    ["Email", clean(m.invitee_email) ? `<mailto:${str(m.invitee_email)}|${esc(m.invitee_email)}>` : ""],
    ["Linkedin", link(clean(m.invitee_linkedin))],
    ["Meeting with", out(m.host)],
    ["Campaign", out(m.campaign)],
  ].filter(([, value]) => value).map(([label, value]) => `*${label}:* ${value}`);
  if (opts.rescheduledFrom) lines.splice(1, 0, `*Was:* ~${esc(opts.rescheduledFrom)}~`);
  // Which meeting this is with the person: the first, a second (they've met before), and whether it moved.
  const number = Number(opts.meetingNumber) || 0;
  const rescheduled = Boolean(opts.rescheduledFrom) || str(m.status) === "rescheduled";
  const tag = number ? `*Meeting #${number}* · ${meetingOrdinal(number)} meeting with this lead${rescheduled ? " · rescheduled" : ""}` : rescheduled ? "*Rescheduled*" : "";
  const text = `${opts.test ? "_Test post. Nothing was sent anywhere else._\n" : ""}${heading}${tag ? `\n${tag}` : ""}\n\n${lines.join("\n")}`;
  return { text: `${canceled ? "Booking canceled" : "New booking"}: ${clean(m.invitee_name) || "someone"}${clean(m.company_name) ? ` (${clean(m.company_name)})` : ""}`, blocks: sections(text) };
}

/** "first", "second"... for the meeting tag; past ten, "11th". */
export function meetingOrdinal(number) {
  const words = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  if (number >= 1 && number <= 10) return words[number - 1];
  const tail = number % 100 >= 11 && number % 100 <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" })[number % 10] ?? "th";
  return `${number}${tail}`;
}

/**
 * Which meeting with this person a booking is: 1 + the earlier, not-canceled bookings of the same person with
 * the same client. The same person is the same email, the same LinkedIn profile, or the same name, any one,
 * because one booking may carry an email and the next only a name.
 */
export function meetingNumberAmong(meeting, others) {
  const m = obj(meeting);
  const norm = (value) => str(value).trim().toLowerCase();
  const handle = (value) => (norm(value).match(/linkedin\.com\/in\/([^/?#\s]+)/)?.[1] ?? "");
  const name = (value) => norm(value).normalize("NFKD").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  const me = { email: norm(m.invitee_email), li: handle(m.invitee_linkedin), name: name(m.invitee_name) };
  const created = Date.parse(str(m.created_at)) || Infinity;
  const same = (other) => {
    const o = obj(other);
    if (me.email && norm(o.invitee_email) === me.email) return true;
    if (me.li && handle(o.invitee_linkedin) === me.li) return true;
    return Boolean(me.name && me.name.includes(" ") && name(o.invitee_name) === me.name);
  };
  const earlier = (Array.isArray(others) ? others : []).filter((other) => {
    const o = obj(other);
    if (str(o.id) && str(o.id) === str(m.id)) return false;
    if (str(o.status) === "canceled") return false;
    return (Date.parse(str(o.created_at)) || 0) < created && same(o);
  });
  return earlier.length + 1;
}

const bullet = (label, value) => (value ? `• *${label}:* ${value}` : "");

/** First reply: LEAD INFO and COMPANY INFO, as the Zaps posted them. */
export function buildInfoThread(meeting) {
  const m = obj(meeting);
  const lead = [
    bullet("Lead Name", out(m.invitee_name)),
    bullet("Lead Title", out(m.invitee_title)),
    bullet("Lead Location", out(m.invitee_location)),
    bullet("Lead Headline", out(m.invitee_headline)),
  ].filter(Boolean);
  const company = [
    bullet("Company Name", out(m.company_name)),
    bullet("Company Domain", clean(m.company_domain) ? link(clean(m.company_domain), clean(m.company_domain)) : ""),
    bullet("Company Linkedin", link(clean(m.company_linkedin))),
    bullet("Company Location", out(m.company_location)),
    bullet("Company Industry", out(m.company_industry)),
    bullet("Company Size", out(m.company_size)),
    bullet("Company Type", out(m.company_type)),
    bullet("Company Description", out(m.company_description)),
  ].filter(Boolean);
  const parts = [];
  if (lead.length) parts.push(`:small_blue_diamond: _*LEAD INFO*_ :small_blue_diamond:\n\n${lead.join("\n\n")}`);
  if (company.length) parts.push(`:small_orange_diamond: _*COMPANY INFO*_ :small_orange_diamond:\n\n${company.join("\n\n")}`);
  const text = parts.join("\n\n\n");
  return { text: `Lead and company info for ${clean(m.invitee_name) || "this booking"}`, blocks: text ? sections(text) : [] };
}

/** Second reply: the TLDR. Empty fields are left out rather than shown blank, which the Zaps did. */
export function buildTldrThread(tldr) {
  const t = obj(tldr);
  const block = (label, value) => {
    const text = out(value);
    if (!text) return "";
    // A call focus is a list; it starts on its own line so the first item lines up with the rest.
    return text.includes("\n") || /^[-•]/.test(text) ? `• *${label}:*\n${text}` : `• *${label}:* ${text}`;
  };
  const lines = BRIEF_SECTIONS.map(([key, label]) => block(label, t[key])).filter(Boolean);
  if (!lines.length) return { text: "", blocks: [] };
  return { text: "TLDR", blocks: sections(`:sparkle: _*TLDR*_ :sparkle:\n\n${lines.join("\n\n")}`) };
}

/** A short note in the thread when a booking is moved or canceled after its card went out. */
export function changeNote(meeting, kind, previousWhen = "") {
  const m = obj(meeting);
  const when = clean(m.meeting_at) ? formatMeetingTime(m.meeting_at) : clean(m.when_text);
  if (kind === "canceled") return `:x: *Canceled* by ${esc(clean(m.invitee_name) || "the invitee")}.`;
  return `:arrows_counterclockwise: *Rescheduled* to ${esc(when)}${previousWhen ? ` (was ${esc(previousWhen)})` : ""}.`;
}

// ── Steps ─────────────────────────────────────────────────────────────────────────────────────────

/** The step types QC can run after enrichment. A new type is a new entry here plus its runner. */
export const STEP_TYPES = ["slack", "hubspot", "webhook"];

/**
 * A client's steps, cleaned: Slack is always present (first), at most one HubSpot step, any number of
 * webhooks with a URL. Each keeps a stable `id` so its result on a meeting survives a reorder.
 */
export function normalizeSteps(steps) {
  const list = Array.isArray(steps) ? steps : [];
  const slack = list.find((step) => obj(step).type === "slack");
  const hubspot = list.find((step) => obj(step).type === "hubspot");
  const out = [{ id: "slack", type: "slack", enabled: slack ? obj(slack).enabled !== false : true }];
  if (hubspot) {
    const h = obj(hubspot);
    out.push({ id: "hubspot", type: "hubspot", enabled: h.enabled !== false, stage: str(h.stage), pipeline: str(h.pipeline), owner: str(h.owner), campaignProperty: str(h.campaignProperty) });
  }
  let n = 0;
  for (const step of list) {
    const s = obj(step);
    if (s.type !== "webhook" || !/^https:\/\//i.test(str(s.url))) continue;
    n += 1;
    out.push({ id: str(s.id) || `webhook_${n}`, type: "webhook", enabled: s.enabled !== false, url: str(s.url), label: str(s.label) });
  }
  return out;
}

/**
 * The row QC adds to the shared Clay table, keyed by the table's own column names so the webhook fills
 * them ("USER title" and "USER company name" are what the person typed on the booking form). `meeting_id`
 * and `callback_url` are QC's: the last column posts back to `callback_url` with `meeting_id` in the body.
 * `Known LinkedIn` is filled when the person is already a lead of ours, so the LinkedIn waterfall can skip.
 */
export function clayRow(meeting, client, callbackUrl, test = false) {
  const m = obj(meeting);
  return {
    meeting_id: str(m.id),
    callback_url: callbackUrl,
    test,
    Client: str(client?.name),
    Campaign: clean(m.campaign),
    Date: clean(m.meeting_at) ? formatMeetingTime(m.meeting_at) : clean(m.when_text),
    "Meeting With": clean(m.host),
    "Meeting Title": clean(m.summary),
    Name: clean(m.invitee_name),
    Email: clean(m.invitee_email),
    "USER title": clean(m.invitee_title),
    "USER company name": clean(m.company_name),
    "Known LinkedIn": clean(m.invitee_linkedin),
  };
}

// ── Pre-call brief ────────────────────────────────────────────────────────────────────────────────

/**
 * The default instructions for the pre-call brief, taken from the Clay prompts it replaces. A client's own
 * instructions (Booked meetings page) replace these; the facts and the output format are always added.
 */
export const DEFAULT_BRIEF_INSTRUCTIONS = [
  "Write pre-call context for a founder or salesperson about to take this meeting.",
  "Lead summary: exactly 3 sentences. Who they are and what they do; their seniority and likely influence on the buying decision; whether they are a strong, moderate, weak or unclear fit, and why.",
  "Company summary: exactly 3 sentences. What the company does; its size, stage and any operating signals; whether it is a strong, moderate, weak or unclear fit, and why.",
  "Call focus: exactly 3 bullets. Short, specific and tactical: what to lead with and what to ask.",
  "Pain points: exactly 3 bullets. The problems this person and company most likely have that the client solves, worded the way the lead would say them.",
  "Base everything on the data given and the client description. Never invent facts or numbers. If something is missing, say \"Not enough data\" briefly.",
  "Business-ready, sharp, no fluff. Under 220 words in total.",
].join("\n");

/** The four sections a brief is made of, in the order Slack shows them. Clay's older two-part fields still read. */
export const BRIEF_SECTIONS = [
  ["leadSummary", "Lead Summary"],
  ["companySummary", "Company Summary"],
  ["callFocus", "Call Focus"],
  ["painPoints", "Pain Points"],
  ["leadCallFocus", "Lead Call Focus"],
  ["companyCallFocus", "Company Call Focus"],
];
