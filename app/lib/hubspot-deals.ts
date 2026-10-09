// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { createHash } from "node:crypto";
import { rest, rows, type Config, type Destination } from "./crm-push";
import { canonicalLinkedin } from "../../shared/crm-push-text.mjs";
import { hubspot, HubSpotError, QC_GROUP, type HubSpotPlan } from "./hubspot-push";

/**
 * Booked meetings into a client's HubSpot as deals. Every meeting QC Command knows about (Calendly, cal.com,
 * the Zapier webhook, a manual add, QC Bot) becomes one deal in a "Booked Meeting (QC)" stage the approved
 * build adds to the client's chosen pipeline, owned by QC Growth, linked to the person's contact and company,
 * with a note carrying the meeting and QC's pre-call brief. A reschedule or cancel updates the same deal; a
 * deal the client has already moved on is never moved back. Which meeting became which deal is in
 * rr_crm_push_meetings.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const list = (value: unknown): Row[] => (Array.isArray(value) ? value.map(object) : []);
const enc = encodeURIComponent;

export const QC_DEAL_STAGE_LABEL = "Booked Meeting (QC)";
const DEAL_PROPERTIES = [
  { name: "qc_meeting_date", label: "QC meeting date", type: "datetime", fieldType: "date", description: "When the meeting QC Growth booked takes place." },
  { name: "qc_meeting_status", label: "QC meeting status", type: "enumeration", fieldType: "select", description: "Scheduled, rescheduled, canceled, completed or no-show.", options: ["scheduled", "rescheduled", "canceled", "completed", "no_show"] },
  { name: "qc_campaign", label: "QC campaign", type: "string", fieldType: "text", description: "The QC Growth campaign the meeting came from." },
];

export type DealsAudit = { pipelines: Array<{ id: string; label: string; stages: Array<{ id: string; label: string }> }>; dealProperties: string[]; dealGroups: string[] };
export type DealsPlan = { enabled: boolean; pipelineId: string | null; pipelineLabel: string; stageId: string | null; stageExists: boolean; createProperties: string[]; pipelines: Array<{ id: string; label: string; hasStage: boolean }> };

/** Read only: the client's deal pipelines and which QC deal fields already exist. */
export async function dealsAudit(token: string): Promise<DealsAudit> {
  const [pipelines, properties, groups] = await Promise.all([
    hubspot(token, "GET", "/crm/v3/pipelines/deals").then((data) => list(data.results)).catch(() => [] as Row[]),
    hubspot(token, "GET", "/crm/v3/properties/deals").then((data) => list(data.results)).catch(() => [] as Row[]),
    hubspot(token, "GET", "/crm/v3/properties/deals/groups").then((data) => list(data.results)).catch(() => [] as Row[]),
  ]);
  return {
    pipelines: pipelines.filter((p) => p.archived !== true).map((p) => ({ id: text(p.id), label: text(p.label), stages: list(p.stages).filter((s) => s.archived !== true).map((s) => ({ id: text(s.id), label: text(s.label) })) })),
    dealProperties: properties.map((p) => text(p.name)),
    dealGroups: groups.map((g) => text(g.name)),
  };
}

const isQcStage = (label: string) => label.trim().toLowerCase() === QC_DEAL_STAGE_LABEL.toLowerCase();

/** Which pipeline (the client's default unless chosen), whether its QC stage exists, and the fields to add. */
export function dealsPlan(audit: DealsAudit, previous?: Partial<DealsPlan> | null): DealsPlan {
  const pipelines = audit.pipelines.map((p) => ({ id: p.id, label: p.label, hasStage: p.stages.some((s) => isQcStage(s.label)) }));
  const chosen = audit.pipelines.find((p) => p.id === previous?.pipelineId) ?? audit.pipelines.find((p) => p.id === "default") ?? audit.pipelines[0] ?? null;
  const stage = chosen?.stages.find((s) => isQcStage(s.label)) ?? null;
  return {
    enabled: previous?.enabled ?? true,
    pipelineId: chosen?.id ?? null,
    pipelineLabel: chosen?.label ?? "",
    stageId: stage?.id ?? null,
    stageExists: Boolean(stage),
    createProperties: DEAL_PROPERTIES.filter((p) => !audit.dealProperties.includes(p.name)).map((p) => p.name),
    pipelines,
  };
}

/** The approved part of the build for deals: the QC deal fields, then the stage at the start of the pipeline. */
export async function dealsApply(token: string, plan: DealsPlan): Promise<{ log: Array<{ at: string; kind: string; name: string; result: "created" | "reused" | "failed"; detail: string }>; stageId: string | null }> {
  const log: Array<{ at: string; kind: string; name: string; result: "created" | "reused" | "failed"; detail: string }> = [];
  const at = () => new Date().toISOString();
  if (!plan.enabled || !plan.pipelineId) return { log, stageId: plan.stageId };
  await hubspot(token, "POST", "/crm/v3/properties/deals/groups", { name: QC_GROUP.name, label: QC_GROUP.label, displayOrder: -1 }).catch(() => undefined);
  for (const spec of DEAL_PROPERTIES.filter((p) => plan.createProperties.includes(p.name))) {
    try {
      await hubspot(token, "POST", "/crm/v3/properties/deals", {
        name: spec.name, label: spec.label, type: spec.type, fieldType: spec.fieldType, groupName: QC_GROUP.name, description: spec.description,
        ...(spec.options ? { options: spec.options.map((value, index) => ({ label: value === "no_show" ? "No-show" : value[0].toUpperCase() + value.slice(1), value, displayOrder: index })) } : {}),
      });
      log.push({ at: at(), kind: "deal-property", name: spec.name, result: "created", detail: spec.label });
    } catch (error) {
      log.push({ at: at(), kind: "deal-property", name: spec.name, result: error instanceof HubSpotError && error.status === 409 ? "reused" : "failed", detail: error instanceof Error ? error.message : "" });
    }
  }
  let stageId = plan.stageId;
  if (!stageId) {
    try {
      // First in the pipeline: a booked meeting comes before every stage the client already works.
      const pipeline = await hubspot(token, "GET", `/crm/v3/pipelines/deals/${enc(plan.pipelineId)}`);
      const first = Math.min(0, ...list(pipeline.stages).map((s) => Number(s.displayOrder) || 0));
      const created = await hubspot(token, "POST", `/crm/v3/pipelines/deals/${enc(plan.pipelineId)}/stages`, { label: QC_DEAL_STAGE_LABEL, displayOrder: first - 1, metadata: { probability: "0.2", isClosed: "false" } });
      stageId = text(created.id);
      log.push({ at: at(), kind: "deal-stage", name: QC_DEAL_STAGE_LABEL, result: "created", detail: `In ${plan.pipelineLabel}` });
    } catch (error) {
      log.push({ at: at(), kind: "deal-stage", name: QC_DEAL_STAGE_LABEL, result: "failed", detail: error instanceof Error ? error.message : "" });
    }
  } else {
    log.push({ at: at(), kind: "deal-stage", name: QC_DEAL_STAGE_LABEL, result: "reused", detail: `In ${plan.pipelineLabel}` });
  }
  return { log, stageId };
}

// ── Push ────────────────────────────────────────────────────────────────────────────────────────

const STATUSES = new Set(["scheduled", "rescheduled", "canceled", "completed", "no_show"]);

function brief(meeting: Row): string {
  const tldr = object(object(meeting.booking).tldr);
  const lines = [
    `Booked meeting · QC Growth`,
    meeting.meeting_at ? `When: ${new Date(text(meeting.meeting_at)).toUTCString().replace(" GMT", " UTC")}` : text(meeting.when_text) ? `When: ${text(meeting.when_text)}` : "",
    text(meeting.host) ? `With: ${text(meeting.host)}` : "",
    text(meeting.campaign) ? `Campaign: ${text(meeting.campaign)}` : "",
    text(meeting.invitee_title) ? `${text(meeting.invitee_name)}, ${text(meeting.invitee_title)}${text(meeting.company_name) ? ` at ${text(meeting.company_name)}` : ""}` : "",
    text(meeting.summary) ? `\nNotes: ${text(meeting.summary)}` : "",
    text(tldr.leadSummary) ? `\nAbout the lead: ${text(tldr.leadSummary)}` : "",
    text(tldr.companySummary) ? `About the company: ${text(tldr.companySummary)}` : "",
    text(tldr.callFocus) ? `Call focus: ${text(tldr.callFocus)}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

const html = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");

type Stored = { deal_id: string | null; contact_id: string | null; company_id: string | null; note_id: string | null; pushed_hash: string | null };

async function findOrCreateContact(token: string, meeting: Row, ownerId: string | null): Promise<string | null> {
  const email = text(meeting.invitee_email).toLowerCase();
  const linkedin = canonicalLinkedin(text(meeting.invitee_linkedin));
  const filterGroups = [
    ...(email ? [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }] : []),
    ...(linkedin ? [{ filters: [{ propertyName: "qc_linkedin_url", operator: "EQ", value: linkedin }] }] : []),
  ];
  if (filterGroups.length) {
    const hit = list((await hubspot(token, "POST", "/crm/v3/objects/contacts/search", { filterGroups, limit: 1, properties: ["email"] }).catch(() => ({} as Row))).results)[0];
    if (hit) return text(hit.id);
  }
  if (!email && !linkedin) return null;
  const [firstname, ...rest] = text(meeting.invitee_name).split(/\s+/);
  const properties: Row = { ...(email ? { email } : {}), firstname: firstname ?? "", lastname: rest.join(" "), jobtitle: text(meeting.invitee_title), company: text(meeting.company_name), ...(linkedin ? { qc_linkedin_url: linkedin } : {}), ...(ownerId ? { hubspot_owner_id: ownerId } : {}) };
  const made = await hubspot(token, "POST", "/crm/v3/objects/contacts", { properties }).catch((error) => {
    const existing = /Existing ID:\s*(\d+)/i.exec(error instanceof Error ? error.message : "")?.[1];
    return existing ? { id: existing } : null;
  });
  return made ? text((made as Row).id) || null : null;
}

async function findOrCreateCompany(token: string, meeting: Row): Promise<string | null> {
  const domain = text(meeting.company_domain).toLowerCase();
  if (!domain) return null;
  const hit = list((await hubspot(token, "POST", "/crm/v3/objects/companies/search", { filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: domain }] }], limit: 1 }).catch(() => ({} as Row))).results)[0];
  if (hit) return text(hit.id);
  const made = await hubspot(token, "POST", "/crm/v3/objects/companies", { properties: { domain, ...(text(meeting.company_name) ? { name: text(meeting.company_name) } : {}), ...(text(meeting.company_linkedin) ? { linkedin_company_page: text(meeting.company_linkedin) } : {}) } }).catch(() => null);
  return made ? text(made.id) || null : null;
}

/** One meeting as one deal: created in the QC stage, or updated in place (never moved back a stage). */
export async function pushMeetingDeal(token: string, destination: Destination, meeting: Row, stored: Stored | undefined): Promise<Stored & { created: boolean }> {
  const plan = object(destination.plan) as unknown as HubSpotPlan & { deals?: DealsPlan };
  const deals = plan.deals;
  if (!deals?.enabled || !deals.pipelineId || !deals.stageId) throw new Error("Booked meetings to deals is not built for this client.");
  const ownerId = plan.settings?.ownerId ?? null;
  const status = STATUSES.has(text(meeting.status)) ? text(meeting.status) : "scheduled";
  const name = [text(meeting.company_name), text(meeting.invitee_name)].filter(Boolean).join(" · ") || "Booked meeting";
  const qc: Row = {
    qc_meeting_status: status,
    ...(meeting.meeting_at ? { qc_meeting_date: new Date(text(meeting.meeting_at)).toISOString() } : {}),
    ...(text(meeting.campaign) ? { qc_campaign: text(meeting.campaign) } : {}),
    ...(text(meeting.summary) ? { description: text(meeting.summary).slice(0, 5000) } : {}),
  };

  // The deal: the one we made, else one the booking alerts already made for this meeting, else a new one.
  let dealId = stored?.deal_id ?? (text(object(object(object(meeting.booking).steps).hubspot).deal_id) || null);
  let created = false;
  if (dealId) {
    const updated = await hubspot(token, "PATCH", `/crm/v3/objects/deals/${enc(dealId)}`, { properties: qc }).catch((error) => (error instanceof HubSpotError && error.status === 404 ? null : Promise.reject(error)));
    if (!updated) dealId = null;
  }
  if (!dealId) {
    const made = await hubspot(token, "POST", "/crm/v3/objects/deals", { properties: { dealname: `${name} (QC Growth)`, pipeline: deals.pipelineId, dealstage: deals.stageId, ...(ownerId ? { hubspot_owner_id: ownerId } : {}), ...qc } });
    dealId = text(made.id);
    created = true;
  }

  const contactId = stored?.contact_id ?? (await findOrCreateContact(token, meeting, ownerId));
  const companyId = stored?.company_id ?? (await findOrCreateCompany(token, meeting));
  if (contactId) await hubspot(token, "PUT", `/crm/v4/objects/deals/${enc(dealId)}/associations/default/contacts/${enc(contactId)}`).catch(() => undefined);
  if (companyId) await hubspot(token, "PUT", `/crm/v4/objects/deals/${enc(dealId)}/associations/default/companies/${enc(companyId)}`).catch(() => undefined);
  if (contactId && companyId) await hubspot(token, "PUT", `/crm/v4/objects/contact/${enc(contactId)}/associations/default/company/${enc(companyId)}`).catch(() => undefined);

  // The meeting and QC's brief, one note on the deal, updated in place.
  const noteBody = html(brief(meeting));
  let noteId = stored?.note_id ?? "";
  if (noteId) {
    const ok = await hubspot(token, "PATCH", `/crm/v3/objects/notes/${enc(noteId)}`, { properties: { hs_note_body: noteBody } }).catch(() => null);
    if (!ok) noteId = "";
  }
  if (!noteId) {
    const note = await hubspot(token, "POST", "/crm/v3/objects/notes", {
      properties: { hs_note_body: noteBody, hs_timestamp: new Date(text(meeting.created_at) || Date.now()).toISOString() },
      associations: [{ to: { id: dealId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] }, ...(contactId ? [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] : [])],
    }).catch(() => null);
    noteId = note ? text(note.id) : "";
  }
  return { deal_id: dealId, contact_id: contactId, company_id: companyId, note_id: noteId || null, pushed_hash: null, created };
}

const meetingHash = (meeting: Row) => createHash("sha256").update(JSON.stringify(["v1", meeting.status, meeting.meeting_at, meeting.when_text, meeting.summary, meeting.campaign, meeting.invitee_name, meeting.invitee_email, meeting.invitee_linkedin, meeting.invitee_title, meeting.company_name, meeting.company_domain, meeting.host, object(object(meeting.booking).tldr)])).digest("hex").slice(0, 32);

/** Every meeting that is new or changed since it was last pushed, as deals. `since` narrows to moved rows. */
export async function pushMeetingsPass(config: Config, destination: Destination, opts: { since?: string; budgetMs?: number } = {}): Promise<{ pushed: number; created: number; updated: number; unchanged: number; failed: number; errors: string[] }> {
  const summary = { pushed: 0, created: 0, updated: 0, unchanged: 0, failed: 0, errors: [] as string[] };
  const plan = object(destination.plan) as unknown as { deals?: DealsPlan };
  if (destination.provider !== "hubspot" || !plan.deals?.enabled || !plan.deals.stageId || !destination.api_key) return summary;
  const started = Date.now();
  const meetings = await rows(config, `rr_meetings?select=*&workspace_id=eq.${enc(destination.workspace_id)}${opts.since ? `&updated_at=gte.${enc(opts.since)}` : ""}&order=created_at.asc&limit=500`);
  if (!meetings.length) return summary;
  const storedRows = await rows(config, `rr_crm_push_meetings?select=*&workspace_id=eq.${enc(destination.workspace_id)}&provider=eq.hubspot&meeting_id=in.(${meetings.map((m) => enc(text(m.id))).join(",")})`).catch(() => [] as Row[]);
  const stored = new Map(storedRows.map((row) => [text(row.meeting_id), row as unknown as Stored]));
  for (const meeting of meetings) {
    if (Date.now() - started > (opts.budgetMs ?? 60_000)) break;
    const id = text(meeting.id);
    const before = stored.get(id);
    const hash = meetingHash(meeting);
    if (before?.pushed_hash === hash) { summary.unchanged += 1; continue; }
    // A canceled meeting that never became a deal stays out; one that did is marked canceled on its deal.
    if (/cancel/i.test(text(meeting.status)) && !before?.deal_id && !text(object(object(object(meeting.booking).steps).hubspot).deal_id)) { summary.unchanged += 1; continue; }
    try {
      const result = await pushMeetingDeal(destination.api_key, destination, meeting, before);
      await rest(config, "rr_crm_push_meetings?on_conflict=workspace_id,meeting_id,provider", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ workspace_id: destination.workspace_id, meeting_id: id, provider: "hubspot", deal_id: result.deal_id, contact_id: result.contact_id, company_id: result.company_id, note_id: result.note_id, pushed_hash: hash, pushed_at: new Date().toISOString(), error: null }) });
      summary.pushed += 1;
      if (result.created) summary.created += 1; else summary.updated += 1;
    } catch (error) {
      const message = (error instanceof Error ? error.message : "failed").slice(0, 300);
      summary.failed += 1;
      if (summary.errors.length < 5) summary.errors.push(`${text(meeting.invitee_name) || "Meeting"}: ${message.slice(0, 160)}`);
      await rest(config, "rr_crm_push_meetings?on_conflict=workspace_id,meeting_id,provider", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ workspace_id: destination.workspace_id, meeting_id: id, provider: "hubspot", deal_id: before?.deal_id ?? null, error: message }) }).catch(() => undefined);
    }
  }
  return summary;
}
