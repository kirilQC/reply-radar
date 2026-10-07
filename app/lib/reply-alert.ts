// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Reply alerts: every lead reply posted to the client's replies channel as a card, with a thread under
 * it holding the conversation, an editable draft and a Send Reply button.
 *
 * This file is the pure half: the Slack blocks, the lead fields the card shows, and the decisions about
 * whether an alert or a send may go ahead. Everything that reads the database or talks to Slack lives in
 * reply-alert-run.ts, so the layout and the exactly-once rules can be tested without either.
 *
 * The card copies the n8n bot it replaces line for line, because the team reads these at a glance and
 * already knows where each field sits. HeyReach's own bot only posts a conversation's first reply; the
 * point of this one is that every reply gets its own card.
 */

import { firstPlaceholder } from "./draft-placeholders";

type Row = Record<string, unknown>;

/** The Send Reply button. Routed by this id in app/api/slack/events/route.ts. */
export const SEND_REPLY_ACTION = "reply_alert_send";
/** The editable draft. Slack hands its current text back under these two ids in `state.values`. */
export const DRAFT_BLOCK_ID = "reply_alert_draft";
export const DRAFT_ACTION_ID = "reply_alert_draft_text";
/** The "Generated Reply" heading: everything from here down is replaced once the reply is sent. */
export const REPLY_HEADING_BLOCK_ID = "reply_alert_reply_heading";

/** How many failed posts before an alert is given up on and recorded as failed. */
export const ALERT_MAX_ATTEMPTS = 3;
/** A claim older than this belongs to a run that died (a function timeout), and may be taken over. */
export const ALERT_CLAIM_STALE_MS = 5 * 60_000;
/** How long after a failed post before it is tried again, so a broken channel is not hit every minute. */
export const ALERT_RETRY_AFTER_MS = 5 * 60_000;
/** A send claim older than this was a crashed send. The send's own 24 hour duplicate check still applies. */
export const SEND_CLAIM_STALE_MS = 10 * 60_000;

/** Slack refuses a section over 3,000 characters; this leaves room for the formatting around a chunk. */
const CHUNK_MAX = 2_800;
/** Slack's ceiling is 50 blocks a message. The thread's fixed blocks take nine of them. */
const MAX_HISTORY_CHUNKS = 30;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

/** Slack mrkdwn treats these three as markup; a company called "AT&T" or a <tag> must survive. */
export const escapeMrkdwn = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A Slack link. A URL holding `|` or `>` would break out of the link, so those are percent-encoded. */
const link = (url: string, label: string) => `<${url.replace(/\|/g, "%7C").replace(/>/g, "%3E")}|${escapeMrkdwn(label)}>`;

const withScheme = (url: string) => (!url ? "" : /^https?:\/\//i.test(url) ? url : `https://${url.replace(/^\/+/, "")}`);

/** The bare domain out of a website or domain value: "https://www.acme.io/about" becomes "acme.io". */
export function bareDomain(value: unknown): string {
  const raw = text(value);
  if (!raw) return "";
  try {
    return new URL(withScheme(raw)).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** AI Ark gives a location as text or as an object; either way it is read as "City, Region, Country". */
function locationText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  const place = object(value);
  if (text(place.default)) return text(place.default);
  const parts = [place.city, place.state || place.region || place.geographicArea, place.country].map(text).filter(Boolean);
  return [...new Set(parts)].join(", ");
}

const number = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * The company's size as the card shows it, before " employees".
 *
 * The enriched headcount first. AI Ark's `staff.total` is never used: it counts the profiles AI Ark
 * happens to hold, which for a large company is a small fraction and reads as a wrong fact. Its
 * `staff.range` is LinkedIn's own size band, so that is the fallback ("10,001+", "51-200").
 */
export function headcountText(headcount: unknown, staff: unknown): string {
  const exact = number(headcount);
  if (exact) return exact.toLocaleString("en-US");
  if (typeof headcount === "string" && /\d/.test(headcount) && headcount.trim().length <= 20) return headcount.trim();
  const range = object(object(staff).range);
  const start = number(range.start);
  const end = number(range.end);
  if (start && end) return `${start.toLocaleString("en-US")}-${end.toLocaleString("en-US")}`;
  if (start) return `${start.toLocaleString("en-US")}+`;
  return "";
}

/** "b2b saas" reads "B2b Saas" from a naive title-case, so a word already carrying capitals is left alone. */
const titleWord = (word: string) => (/[A-Z]/.test(word.slice(1)) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());

/** Up to three short tags from AI Ark's company keywords and hashtags, title-cased and deduplicated. */
export function patternTags(company: unknown): string[] {
  const source = object(company);
  const values = [source.keywords, source.hashtags, object(source.summary).keywords, object(source.summary).hashtags].flatMap((value) =>
    Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [],
  );
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = text(typeof value === "string" ? value : object(value).name).replace(/^#+/, "").replace(/\s+/g, " ").trim();
    // A sentence pasted in as a keyword is not a tag.
    if (!tag || tag.length > 40) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag.split(" ").map(titleWord).join(" "));
    if (tags.length === 3) break;
  }
  return tags;
}

/** Everything the card says about the lead and their company. Empty strings are lines left out. */
export type AlertLead = {
  name: string;
  title: string;
  headline: string;
  linkedinUrl: string;
  email: string;
  location: string;
  company: string;
  industry: string;
  headcount: string;
  tags: string[];
  domain: string;
  companyLinkedinUrl: string;
};

/**
 * The card's lead fields out of an rr_leads row: its own columns first, AI Ark's enrichment second.
 *
 * The row is read with `select=*` because the columns differ between this database and the schema
 * file, and naming one that does not exist fails the whole read.
 */
export function leadFromRow(row: Row): AlertLead {
  const ai = object(object(object(row.raw_data).reply_radar).ai_ark);
  const company = object(ai.company);
  const summary = object(company.summary);
  const companyLinks = object(company.link);
  // AI Ark stores industries lower case ("software development"); the card reads them as titles.
  const rawIndustry = text(row.company_industry) || text(summary.industry) || text(company.industry) || text(ai.industry);
  const industry = rawIndustry === rawIndustry.toLowerCase() ? rawIndustry.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase()) : rawIndustry;
  return {
    name: text(row.name),
    title: text(row.role) || text(ai.title),
    headline: text(ai.headline),
    linkedinUrl: withScheme(text(row.linkedin_profile_url)),
    email: text(row.email),
    location: text(row.lead_location) || locationText(ai.location),
    company: text(row.company) || text(summary.name) || text(company.name),
    industry,
    headcount: headcountText(row.company_headcount, summary.staff ?? company.staff),
    tags: patternTags(company),
    domain: bareDomain(row.company_domain) || bareDomain(companyLinks.website) || bareDomain(summary.website),
    companyLinkedinUrl: withScheme(text(companyLinks.linkedin)),
  };
}

/** One stored message as the alert reads it. */
export type AlertMessage = { id: string; direction: string; body: string; sentAt: string; senderName?: string };

/** "Reply #N": how many messages the lead has sent in this conversation up to and including this one. */
export function replyNumber(messages: AlertMessage[], target: AlertMessage): number {
  const at = Date.parse(target.sentAt);
  const count = messages.filter((message) => message.direction === "inbound" && Date.parse(message.sentAt) <= at).length;
  return Math.max(1, count);
}

const section = (mrkdwn: string, blockId?: string) => ({ type: "section", ...(blockId ? { block_id: blockId } : {}), text: { type: "mrkdwn", text: mrkdwn } });

/**
 * Plain text as preformatted rich text, in as many blocks as it takes.
 *
 * Not a section: Slack folds a long section behind "Show more", and the conversation is the one thing
 * the reader came to see. Rich text is also literal, so nothing a lead wrote is read as markup.
 */
function preformatted(value: string): Row[] {
  const chunks: string[] = [];
  let current = "";
  for (const piece of value.split("\n\n")) {
    const pieces = piece.length > CHUNK_MAX ? (piece.match(new RegExp(`[\\s\\S]{1,${CHUNK_MAX}}`, "g")) ?? []) : [piece];
    for (const part of pieces) {
      if (!current) current = part;
      else if (current.length + 2 + part.length <= CHUNK_MAX) current += `\n\n${part}`;
      else { chunks.push(current); current = part; }
    }
  }
  if (current || !chunks.length) chunks.push(current || " ");
  return chunks.map((chunk) => ({
    type: "rich_text",
    elements: [{ type: "rich_text_preformatted", elements: [{ type: "text", text: chunk }] }],
  }));
}

export type AlertCardInput = {
  lead: AlertLead;
  replyNumber: number;
  senderName: string;
  campaignName: string;
  clientName: string;
  /** The lead's latest message, shown on the card under the lead and campaign details. */
  latestReply?: string;
  /** A sample posted from Configuration to the test channel. */
  test?: boolean;
};

/** The top-level card: who replied, their company, and who on our side they replied to. */
export function buildAlertCard(input: AlertCardInput): { text: string; blocks: Row[] } {
  const { lead } = input;
  const line = (label: string, value: string) => (value ? `*${label}:* ${value}` : "");
  const group = (...lines: string[]) => lines.filter(Boolean).join("\n");
  const person = group(
    line("Name", escapeMrkdwn(lead.name)),
    line("Title", escapeMrkdwn(lead.title)),
    line("Headline", escapeMrkdwn(lead.headline)),
    line("LinkedIn", lead.linkedinUrl ? link(lead.linkedinUrl, "View Profile") : ""),
    line("Email", escapeMrkdwn(lead.email)),
    line("Location", escapeMrkdwn(lead.location)),
  );
  const industry = [lead.industry ? escapeMrkdwn(lead.industry) : "", lead.headcount ? `${lead.headcount} employees` : ""].filter(Boolean).join(" | ");
  const company = group(
    line("Company", escapeMrkdwn(lead.company)),
    line("Industry", industry),
    line("Pattern Tags", escapeMrkdwn(lead.tags.join(", "))),
    line("Domain", lead.domain ? link(`https://${lead.domain}`, lead.domain) : ""),
    line("Company LinkedIn", lead.companyLinkedinUrl ? link(lead.companyLinkedinUrl, "View Profile") : ""),
  );
  const ours = group(line("Sender", escapeMrkdwn(input.senderName)), line("Campaign", escapeMrkdwn(input.campaignName)));
  // :email: for a first reply, :arrows_counterclockwise: for a lead writing back again, as the n8n bot did.
  const turn = Math.max(1, input.replyNumber);
  const blocks: Row[] = [section(`${turn === 1 ? ":email:" : ":arrows_counterclockwise:"} *New Reply · Reply #${turn}*`)];
  for (const part of [person, company, ours]) if (part) blocks.push(section(part));
  // The reply itself, on the card, so the channel reads as a list of what leads said without opening
  // threads. Preformatted, as the n8n bot showed it, so nothing a lead typed is read as markup.
  const latestReply = (input.latestReply ?? "").trim();
  if (latestReply) blocks.push(section("*Latest Lead Reply*"), ...preformatted(latestReply).slice(0, 5));
  if (input.test) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "_Test post. Nothing will be sent from it._" }] });
  const who = lead.name || "a lead";
  return { text: `${input.test ? "Test: " : ""}New reply from ${who}${input.clientName ? ` (${input.clientName})` : ""}`, blocks };
}

/** What the Send Reply button carries: enough to find the reply again, and whether it is a test card. */
export type SendValue = { messageId: string; conversationId: string; test: boolean };

export function parseSendValue(value: unknown): SendValue | null {
  try {
    const parsed = object(JSON.parse(String(value ?? "")));
    const messageId = text(parsed.m);
    const conversationId = text(parsed.c);
    if (!messageId || !conversationId) return null;
    return { messageId, conversationId, test: parsed.t === 1 };
  } catch {
    return null;
  }
}

export type AlertThreadInput = {
  messages: AlertMessage[];
  /** The newest message from the lead, which the draft answers. */
  latest: AlertMessage;
  /** The reply this alert is for. Usually `latest`; older when a sweep catches up on a missed one. */
  messageId: string;
  leadName: string;
  senderName: string;
  draft: string;
  conversationId: string;
  test?: boolean;
};

/** Who said a message, by name: the sender for ours, the lead for theirs. */
const speaker = (message: AlertMessage, leadName: string, senderName: string) =>
  message.direction === "outbound" ? message.senderName || senderName || "Us" : leadName || "Lead";

/**
 * The threaded reply: the whole conversation, the reply this alert is about, and the draft to send.
 *
 * The history is numbered from the first message even when the oldest are left out for length, so
 * "Reply #4" on the card and the numbers here never disagree about which message is which.
 */
export function buildAlertThread(input: AlertThreadInput): { text: string; blocks: Row[] } {
  const entries = input.messages.map((message, index) => `${index + 1}. ${speaker(message, input.leadName, input.senderName)}: ${message.body.trim()}`);
  let shown = entries;
  let history = preformatted(shown.join("\n\n"));
  while (history.length > MAX_HISTORY_CHUNKS && shown.length > 1) {
    shown = shown.slice(Math.ceil(shown.length / 4));
    const hidden = entries.length - shown.length;
    history = preformatted([`(${hidden} earlier message${hidden === 1 ? "" : "s"} not shown)`, ...shown].join("\n\n"));
  }
  const draft = input.draft.trim().slice(0, 3_000);
  const confirmText = `Send this reply to ${input.leadName || "this lead"} on LinkedIn from ${input.senderName || "the sender"}?`;
  const blocks: Row[] = [
    section("*Conversation History*"),
    ...history,
    // The latest lead reply sits on the card itself, so the thread is the history and the draft.
    // This divider marks where the draft starts: everything from it down is replaced once sent.
    { type: "divider", block_id: REPLY_HEADING_BLOCK_ID },
    {
      type: "input",
      block_id: DRAFT_BLOCK_ID,
      dispatch_action: false,
      // Slack requires a label on an input, so it is the heading rather than a second one above it.
      label: { type: "plain_text", text: "Generated Reply", emoji: false },
      element: {
        type: "plain_text_input",
        action_id: DRAFT_ACTION_ID,
        multiline: true,
        max_length: 3_000,
        ...(draft ? { initial_value: draft } : { placeholder: { type: "plain_text", text: "Write the reply" } }),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SEND_REPLY_ACTION,
          style: "primary",
          text: { type: "plain_text", text: "Send Reply", emoji: false },
          value: JSON.stringify({ m: input.messageId, c: input.conversationId, ...(input.test ? { t: 1 } : {}) }),
          confirm: {
            title: { type: "plain_text", text: "Send reply?" },
            text: { type: "plain_text", text: confirmText.slice(0, 300) },
            confirm: { type: "plain_text", text: "Send" },
            deny: { type: "plain_text", text: "Cancel" },
          },
        },
      ],
    },
  ];
  return { text: `Conversation with ${input.leadName || "the lead"}`, blocks };
}

/** The text in the draft box when the button was pressed, as Slack reports it. */
export function draftFromState(state: unknown): string {
  const values = object(object(state).values);
  const field = object(object(values[DRAFT_BLOCK_ID])[DRAFT_ACTION_ID]);
  return typeof field.value === "string" ? field.value.trim() : "";
}

/**
 * Whether a reply may go out as written. A draft still holding a blank like "(insert time here)" is
 * refused: sent as is, the lead reads the instruction to us instead of the time.
 */
export function sendableCheck(message: string): { ok: true } | { ok: false; reason: string } {
  if (!message.trim()) return { ok: false, reason: "The reply is empty. Write something first." };
  const blank = firstPlaceholder(message);
  if (blank) return { ok: false, reason: `Fill in ${blank} before sending. Nothing was sent.` };
  return { ok: true };
}

/** "Oct 7, 3:42 PM ET". */
export const easternTime = (at: Date) =>
  `${at.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} ET`;

/**
 * The thread message once the reply is sent: the box and the button give way to who sent it, when, and
 * exactly what went out, so nobody presses Send on a reply that has already gone.
 */
export function sentThreadBlocks(blocks: unknown, sent: { userId: string; message: string; at: Date }): Row[] {
  const list = Array.isArray(blocks) ? (blocks as Row[]) : [];
  const cut = list.findIndex((block) => block.block_id === REPLY_HEADING_BLOCK_ID);
  const kept = (cut >= 0 ? list.slice(0, cut) : list.filter((block) => block.type !== "input" && block.type !== "actions"));
  const quoted = escapeMrkdwn(sent.message.trim()).split("\n").map((row) => `>${row ? ` ${row}` : ""}`).join("\n");
  const quotes: Row[] = [];
  for (let start = 0; start < quoted.length; start += CHUNK_MAX) quotes.push(section(quoted.slice(start, start + CHUNK_MAX)));
  return [...kept, section(`*Sent by* <@${sent.userId}> · ${easternTime(sent.at)}`), ...quotes];
}

/**
 * Every stored copy of one reply: the same text in the same conversation within NEAR_DUPLICATE_MS.
 *
 * An earlier release could store a message twice, and a refresh can mint a second id for it. Each copy
 * would otherwise get its own claim and its own card, so the claim is keyed on the group's oldest id,
 * which every copy works out the same way. Same rule as app/lib/message-dedupe.ts.
 */
export function twinIds(messages: Array<{ id: string; body: string; sentAt: string }>, target: { id: string; body: string; sentAt: string }, windowMs: number): string[] {
  const at = Date.parse(target.sentAt);
  const body = target.body.trim();
  const ids = messages
    .filter((message) => message.id === target.id || (message.body.trim() === body && Math.abs(Date.parse(message.sentAt) - at) < windowMs))
    .sort((a, b) => Date.parse(a.sentAt) - Date.parse(b.sentAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((message) => message.id);
  return ids.includes(target.id) ? ids : [target.id, ...ids];
}

/** The exactly-once record for one alert, kept in rr_app_config under `reply_alert:{id}`. */
export type AlertClaim = {
  status: "claimed" | "posted" | "failed";
  token: string;
  attempts: number;
  claimed_at: string;
  failed_at?: string;
  error?: string;
  channel?: string;
  ts?: string;
  thread_ts?: string;
  posted_at?: string;
};

/**
 * What to do about an alert given its claim record.
 *
 * take     nobody has it, or whoever had it failed or died: post it.
 * posted   it is already in Slack.
 * busy     someone is posting it now, or it failed moments ago and is waiting out its retry delay.
 * gave_up  it failed ALERT_MAX_ATTEMPTS times; it is recorded as failed and left alone.
 *
 * A claim that went stale counts as a failed attempt, because the usual cause is a function killed
 * part way through, which will happen again for the same reason.
 */
export function claimVerdict(existing: AlertClaim | null, now: number): "take" | "posted" | "busy" | "gave_up" {
  if (!existing) return "take";
  if (existing.status === "posted") return "posted";
  const attempts = Number(existing.attempts) || 0;
  if (existing.status === "failed") {
    if (attempts >= ALERT_MAX_ATTEMPTS) return "gave_up";
    const failedAt = Date.parse(existing.failed_at ?? existing.claimed_at);
    return Number.isFinite(failedAt) && now - failedAt < ALERT_RETRY_AFTER_MS ? "busy" : "take";
  }
  const claimedAt = Date.parse(existing.claimed_at);
  if (Number.isFinite(claimedAt) && now - claimedAt < ALERT_CLAIM_STALE_MS) return "busy";
  return attempts + 1 >= ALERT_MAX_ATTEMPTS ? "gave_up" : "take";
}

/** The send's own claim, under `reply_alert_send:{id}`: one reply per alert, however many presses. */
export type SendClaim = { status: "sending" | "sent"; token: string; at: string; by?: string };

export function sendClaimVerdict(existing: SendClaim | null, now: number): "take" | "sent" | "busy" {
  if (!existing) return "take";
  if (existing.status === "sent") return "sent";
  const at = Date.parse(existing.at);
  return Number.isFinite(at) && now - at < SEND_CLAIM_STALE_MS ? "busy" : "take";
}
