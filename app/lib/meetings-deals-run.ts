// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { createHash } from "node:crypto";
import { rest, rows, type Config, type Destination } from "./crm-push";
import { pushMeetingDeal } from "./hubspot-deals";
import { attioPushMeetingDeal } from "./attio-deals";

/**
 * Booked meetings to deals in whichever CRM the client uses (HubSpot or Attio), for every meeting that is new or
 * changed since it was last pushed. Which meeting became which deal is in rr_crm_push_meetings.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const enc = encodeURIComponent;
type Stored = { deal_id: string | null; contact_id: string | null; company_id: string | null; note_id: string | null; pushed_hash: string | null };

const FREE_MAIL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|mac|aol|proton|protonmail|gmx|mail|yandex|zoho)\./i;

/**
 * A meeting as scheduler payloads really arrive, cleaned before it becomes a deal: "Jane Doe; Jane Doe" or
 * "Jane Doe;" (a Zap pasting a name twice) becomes "Jane Doe", and a work email gives the company domain
 * when the booking carried none.
 */
export function cleanMeeting(meeting: Row): Row {
  const name = text(meeting.invitee_name).split(";").map((part) => part.trim()).find(Boolean) ?? "";
  const email = text(meeting.invitee_email).toLowerCase();
  const domain = text(meeting.company_domain) || (email.includes("@") && !FREE_MAIL.test(email) ? email.split("@")[1] : "");
  return { ...meeting, invitee_name: name.replace(/,\s*(CSM|CSPO|MBA|PhD|MD|PMP|CPA)(,.*)?$/i, "").trim(), company_domain: domain };
}

/** The person behind a meeting, so a second booking by them updates their deal instead of making another. */
const personKey = (meeting: Row) => text(meeting.invitee_email).toLowerCase() || text(meeting.invitee_linkedin).toLowerCase().replace(/\/+$/, "") || text(meeting.invitee_name).toLowerCase();
const internal = (meeting: Row) => /@qcgrowth\.com$/i.test(text(meeting.invitee_email)) || /^qc growth$/i.test(text(meeting.company_name));

const meetingHash = (meeting: Row) => createHash("sha256").update(JSON.stringify(["v3", meeting.status, meeting.meeting_at, meeting.when_text, meeting.summary, meeting.campaign, meeting.invitee_name, meeting.invitee_email, meeting.invitee_linkedin, meeting.invitee_title, meeting.company_name, meeting.company_domain, meeting.host, object(object(meeting.booking).tldr)])).digest("hex").slice(0, 32);

/** Every meeting that is new or changed since it was last pushed, as deals. `since` narrows to moved rows. */
export async function pushMeetingsPass(config: Config, destination: Destination, opts: { since?: string; budgetMs?: number } = {}): Promise<{ pushed: number; created: number; updated: number; unchanged: number; failed: number; errors: string[] }> {
  const summary = { pushed: 0, created: 0, updated: 0, unchanged: 0, failed: 0, errors: [] as string[] };
  const deals = object(object(destination.plan).deals);
  const ready = destination.provider === "hubspot" ? deals.enabled === true && Boolean(deals.stageId) : destination.provider === "attio" ? deals.enabled === true && deals.available === true : false;
  if (!ready || !destination.api_key) return summary;
  const provider = destination.provider;
  const push = provider === "attio" ? attioPushMeetingDeal : pushMeetingDeal;
  const started = Date.now();
  const meetings = await rows(config, `rr_meetings?select=*&workspace_id=eq.${enc(destination.workspace_id)}${opts.since ? `&updated_at=gte.${enc(opts.since)}` : ""}&order=meeting_at.asc.nullsfirst,created_at.asc&limit=500`);
  if (!meetings.length) return summary;
  const storedRows = await rows(config, `rr_crm_push_meetings?select=*&workspace_id=eq.${enc(destination.workspace_id)}&provider=eq.${enc(provider)}&meeting_id=in.(${meetings.map((m) => enc(text(m.id))).join(",")})`);
  // (No catch: without knowing which deals exist, pushing would make every one of them again.)
  const stored = new Map(storedRows.map((row) => [text(row.meeting_id), row as unknown as Stored]));
  // Deals already made per person (from earlier passes or earlier in this one): later bookings reuse them.
  const byPerson = new Map<string, Stored>();
  for (const raw of meetings) {
    const known = stored.get(text(raw.id));
    if (known?.deal_id) byPerson.set(personKey(cleanMeeting(raw)), known);
  }
  for (const raw of meetings) {
    const meeting = cleanMeeting(raw);
    if (internal(meeting)) { summary.unchanged += 1; continue; }
    if (Date.now() - started > (opts.budgetMs ?? 60_000)) break;
    const id = text(meeting.id);
    const own = stored.get(id);
    const before = own ?? byPerson.get(personKey(meeting));
    // An old booking canceled while the person's deal follows a newer one leaves that deal alone.
    if (!own && before && /cancel/i.test(text(meeting.status))) { summary.unchanged += 1; continue; }
    const hash = meetingHash(meeting);
    if (before?.pushed_hash === hash) { summary.unchanged += 1; continue; }
    // A canceled meeting that never became a deal stays out; one that did is marked canceled on its deal.
    if (/cancel/i.test(text(meeting.status)) && !before?.deal_id && !(provider !== "hubspot" || !text(object(object(object(meeting.booking).steps).hubspot).deal_id))) { summary.unchanged += 1; continue; }
    try {
      const result = await push(destination.api_key, destination, meeting, before, config);
      byPerson.set(personKey(meeting), { ...result, pushed_hash: null });
      const saved = await rest(config, "rr_crm_push_meetings?on_conflict=workspace_id,meeting_id,provider", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ workspace_id: destination.workspace_id, meeting_id: id, provider, deal_id: result.deal_id, contact_id: result.contact_id, company_id: result.company_id, note_id: result.note_id, pushed_hash: hash, pushed_at: new Date().toISOString(), error: null }) });
      if (!saved.ok) throw new Error(`Deal ${result.deal_id} made, but QC Command could not remember it (${saved.status}). Stopping so it is not made twice.`);
      summary.pushed += 1;
      if (result.created) summary.created += 1; else summary.updated += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : "failed").slice(0, 300);
      summary.failed += 1;
      if (summary.errors.length < 5) summary.errors.push(`${text(meeting.invitee_name) || "Meeting"}: ${message.slice(0, 160)}`);
      await rest(config, "rr_crm_push_meetings?on_conflict=workspace_id,meeting_id,provider", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ workspace_id: destination.workspace_id, meeting_id: id, provider, deal_id: before?.deal_id ?? null, error: message }) }).catch(() => undefined);
    }
  }
  return summary;
}
