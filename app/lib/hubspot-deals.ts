// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { conversationText, replyRecords, rows, type Config, type Destination, type ReplyRecord } from "./crm-push";
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
export type DealSpec = { name: string; label: string; type: string; fieldType: string; description: string; options?: string[] };
const textField = (name: string, label: string, description: string, long = false): DealSpec => ({ name, label, type: "string", fieldType: long ? "textarea" : "text", description });
/** Everything QC knows about the meeting, the person and the outreach, as fields on the deal. */
export const DEAL_PROPERTIES: DealSpec[] = [
  { name: "qc_meeting_date", label: "QC meeting date", type: "datetime", fieldType: "date", description: "When the meeting QC Growth booked takes place." },
  { name: "qc_meeting_status", label: "QC meeting status", type: "enumeration", fieldType: "select", description: "Scheduled, rescheduled, canceled, completed or no-show.", options: ["scheduled", "rescheduled", "canceled", "completed", "no_show"] },
  textField("qc_meeting_host", "QC meeting host", "Who the meeting is with on the client's side."),
  textField("qc_campaign", "QC campaign", "The QC Growth campaign the meeting came from."),
  textField("qc_lead_name", "QC lead name", "The person who booked."),
  textField("qc_lead_title", "QC lead title", "Their job title."),
  textField("qc_lead_email", "QC lead email", "Their email."),
  textField("qc_lead_linkedin", "QC lead LinkedIn", "Their LinkedIn profile."),
  textField("qc_company_domain", "QC company domain", "The company's website."),
  textField("qc_company_linkedin", "QC company LinkedIn", "The company's LinkedIn page."),
  textField("qc_company_industry", "QC company industry", "The company's industry."),
  textField("qc_company_size", "QC company size", "The company's headcount."),
  textField("qc_company_location", "QC company location", "Where the company is."),
  textField("qc_sender", "QC sender", "Who QC's outreach came from."),
  textField("qc_outreach_platform", "QC outreach platform", "HeyReach, lemlist or Email Bison."),
  textField("qc_reply_sentiment", "QC reply sentiment", "How the lead's latest reply read."),
  textField("qc_latest_reply", "QC latest reply", "The lead's most recent reply.", true),
  textField("qc_conversation", "QC conversation", "The whole outreach conversation, oldest first.", true),
  textField("qc_pre_call_brief", "QC pre-call brief", "QC's brief on the lead and company for the call.", true),
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
      // HubSpot refuses a negative position, so the client's stages each move down one (their order kept)
      // and the QC stage takes position 0.
      const pipeline = await hubspot(token, "GET", `/crm/v3/pipelines/deals/${enc(plan.pipelineId)}`);
      const stages = list(pipeline.stages).filter((s) => s.archived !== true).sort((a, b) => (Number(a.displayOrder) || 0) - (Number(b.displayOrder) || 0));
      for (const [index, stage] of stages.entries()) {
        await hubspot(token, "PATCH", `/crm/v3/pipelines/deals/${enc(plan.pipelineId)}/stages/${enc(text(stage.id))}`, { displayOrder: index + 1 });
      }
      const created = await hubspot(token, "POST", `/crm/v3/pipelines/deals/${enc(plan.pipelineId)}/stages`, { label: QC_DEAL_STAGE_LABEL, displayOrder: 0, metadata: { probability: "0.2", isClosed: "false" } });
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

export function brief(meeting: Row): string {
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
/** The lead's reply conversation for this meeting (by LinkedIn, then email), for the outreach fields. */
async function replyFor(config: Config, workspaceId: string, meeting: Row): Promise<ReplyRecord | null> {
  const handle = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(text(meeting.invitee_linkedin))?.[1] ?? "";
  const email = text(meeting.invitee_email).toLowerCase();
  // Same name: first and last name both in the lead's name ("Yvette Domke" for "Yvette Lynn Domke"), the
  // fallback when the booking carries a personal email and no LinkedIn. Only within this client's leads.
  const words = text(meeting.invitee_name).toLowerCase().replace(/[^a-z\s'-]/g, " ").split(/\s+/).filter((word) => word.length > 1 && !["dr", "md", "phd", "mba", "jr", "sr", "ii", "iii"].includes(word));
  const byName = words.length >= 2 ? `and(name.ilike.*${words[0]}*,name.ilike.*${words[words.length - 1]}*)` : "";
  const filters = [
    handle ? `linkedin_profile_url.ilike.*${handle.replace(/[,()*]/g, "")}*` : "",
    email ? `raw_data->reply_radar->>email.eq.${email}` : "",
    byName,
  ].filter(Boolean);
  if (!filters.length) return null;
  const leads = await rows(config, `rr_leads?select=id&workspace_id=eq.${enc(workspaceId)}&or=(${filters.map(enc).join(",")})&limit=5`).catch(() => [] as Row[]);
  if (!leads.length) return null;
  const { records } = await replyRecords(config, workspaceId, { leadIds: leads.map((lead) => text(lead.id)), limit: 10 }).catch(() => ({ records: [] as ReplyRecord[] }));
  return records[0] ?? null;
}

/**
 * Everything QC knows about a booked meeting, CRM-neutral: the deal's name (the company, else the person) and
 * the QC field values keyed by field name, from the meeting and from the lead's reply conversation.
 */
export async function dealFacts(config: Config, workspaceId: string, meeting: Row): Promise<{ name: string; status: string; fields: Row; description: string; reply: ReplyRecord | null }> {
  const status = STATUSES.has(text(meeting.status)) ? text(meeting.status) : "scheduled";
  const reply = await replyFor(config, workspaceId, meeting);
  const fields: Row = {};
  const put = (key: string, value: unknown) => { if (value !== "" && value !== null && value !== undefined) fields[key] = value; };
  put("qc_meeting_status", status);
  put("qc_meeting_date", meeting.meeting_at ? new Date(text(meeting.meeting_at)).toISOString() : "");
  put("qc_meeting_host", text(meeting.host));
  put("qc_campaign", text(meeting.campaign) || reply?.campaign);
  put("qc_lead_name", text(meeting.invitee_name) || reply?.name);
  put("qc_lead_title", text(meeting.invitee_title) || reply?.title);
  put("qc_lead_email", text(meeting.invitee_email) || reply?.email);
  put("qc_lead_linkedin", canonicalLinkedin(text(meeting.invitee_linkedin)) || reply?.linkedinCanonical);
  put("qc_company_domain", text(meeting.company_domain) || reply?.domain);
  put("qc_company_linkedin", text(meeting.company_linkedin) || reply?.companyLinkedinUrl);
  put("qc_company_industry", text(meeting.company_industry));
  put("qc_company_size", text(meeting.company_size));
  put("qc_company_location", text(meeting.company_location));
  put("qc_sender", reply?.sender);
  put("qc_outreach_platform", reply?.platform);
  put("qc_reply_sentiment", reply?.sentiment ? reply.sentiment[0].toUpperCase() + reply.sentiment.slice(1) : "");
  put("qc_latest_reply", reply?.latestReply.slice(0, 5000));
  put("qc_conversation", reply ? conversationText(reply, 60_000, "plain") : "");
  put("qc_pre_call_brief", brief(meeting));
  return {
    name: text(meeting.company_name) || reply?.company || text(meeting.invitee_name) || "Booked meeting",
    status,
    fields,
    description: (text(meeting.summary) || text(meeting.company_description)).slice(0, 5000),
    reply,
  };
}

export async function pushMeetingDeal(token: string, destination: Destination, meeting: Row, stored: Stored | undefined, config: Config): Promise<Stored & { created: boolean }> {
  const plan = object(destination.plan) as unknown as HubSpotPlan & { deals?: DealsPlan };
  const deals = plan.deals;
  if (!deals?.enabled || !deals.pipelineId || !deals.stageId) throw new Error("Booked meetings to deals is not built for this client.");
  const ownerId = plan.settings?.ownerId ?? null;
  // The deal is the company; the person when the booking carries no company.
  const facts = await dealFacts(config, destination.workspace_id, meeting);
  const name = facts.name;
  const qc: Row = { ...facts.fields };
  if (facts.description) qc.description = facts.description;

  // The deal: the one we made, else one the booking alerts already made for this meeting, else a new one.
  let dealId = stored?.deal_id ?? (text(object(object(object(meeting.booking).steps).hubspot).deal_id) || null);
  let created = false;
  if (dealId) {
    // The name is only ever corrected from QC's old "… (QC Growth)" form; a name the client chose stays.
    const current = await hubspot(token, "GET", `/crm/v3/objects/deals/${enc(dealId)}?properties=dealname`).catch((error) => (error instanceof HubSpotError && error.status === 404 ? null : Promise.reject(error)));
    if (current) {
      // QC's own names only: the old "… (QC Growth)" form, or the person's name used before the company was known.
      const currentName = text(object(current.properties).dealname);
      const ours = /\(QC Growth\)$/.test(currentName) || (currentName === text(meeting.invitee_name) && name !== currentName);
      const rename = ours ? { dealname: name } : {};
      await hubspot(token, "PATCH", `/crm/v3/objects/deals/${enc(dealId)}`, { properties: { ...qc, ...rename } });
    } else {
      dealId = null;
    }
  }
  if (!dealId) {
    const made = await hubspot(token, "POST", "/crm/v3/objects/deals", { properties: { dealname: name, pipeline: deals.pipelineId, dealstage: deals.stageId, ...(ownerId ? { hubspot_owner_id: ownerId } : {}), ...qc } });
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

