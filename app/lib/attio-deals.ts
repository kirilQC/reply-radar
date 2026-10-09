// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { attio, AttioError, writeTolerant, type AttioPlan } from "./attio-push";
import { brief, DEAL_PROPERTIES, dealFacts } from "./hubspot-deals";
import { canonicalLinkedin } from "../../shared/crm-push-text.mjs";
import type { Config, Destination } from "./crm-push";

/**
 * Booked meetings into a client's Attio as deals: the same facts as HubSpot (dealFacts), on Attio's Deals
 * object. The approved build adds a "Booked Meeting (QC)" status to the deal stage and QC's deal attributes;
 * every meeting becomes one deal in that stage, owned by the QC Growth member, linked to the person and
 * company, with a note. Updates never move a deal's stage. The Deals object must be switched on in Attio.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const list = (value: unknown): Row[] => (Array.isArray(value) ? value.map(object) : []);

export const QC_DEAL_STATUS = "Booked Meeting (QC)";
const ATTIO_TYPE: Record<string, "text" | "timestamp" | "select"> = { qc_meeting_date: "timestamp", qc_meeting_status: "select" };
const STATUS_TITLES: Record<string, string> = { scheduled: "Scheduled", rescheduled: "Rescheduled", canceled: "Canceled", completed: "Completed", no_show: "No-show" };

export type AttioDealsPlan = { enabled: boolean; available: boolean; statusExists: boolean; createAttributes: string[]; stages: string[] };

export async function attioDealsAudit(token: string): Promise<{ available: boolean; stages: string[]; attributes: string[] }> {
  const object = await attio(token, "GET", "/objects/deals").catch(() => null);
  if (!object) return { available: false, stages: [], attributes: [] };
  const [statuses, attributes] = await Promise.all([
    attio(token, "GET", "/objects/deals/attributes/stage/statuses").then((data) => list(data.data)).catch(() => [] as Row[]),
    attio(token, "GET", "/objects/deals/attributes").then((data) => list(data.data)).catch(() => [] as Row[]),
  ]);
  return { available: true, stages: statuses.filter((s) => s.is_archived !== true).map((s) => text(s.title)), attributes: attributes.map((a) => text(a.api_slug)) };
}

export function attioDealsPlan(audit: { available: boolean; stages: string[]; attributes: string[] }, previous?: Partial<AttioDealsPlan> | null): AttioDealsPlan {
  return {
    enabled: previous?.enabled ?? audit.available,
    available: audit.available,
    statusExists: audit.stages.some((title) => title.trim().toLowerCase() === QC_DEAL_STATUS.toLowerCase()),
    createAttributes: DEAL_PROPERTIES.map((p) => p.name).filter((slug) => !audit.attributes.includes(slug)),
    stages: audit.stages,
  };
}

export async function attioDealsApply(token: string, plan: AttioDealsPlan): Promise<Array<{ at: string; kind: string; name: string; result: "created" | "reused" | "failed"; detail: string }>> {
  const log: Array<{ at: string; kind: string; name: string; result: "created" | "reused" | "failed"; detail: string }> = [];
  const at = () => new Date().toISOString();
  if (!plan.enabled || !plan.available) return log;
  for (const spec of DEAL_PROPERTIES.filter((p) => plan.createAttributes.includes(p.name))) {
    const type = ATTIO_TYPE[spec.name] ?? "text";
    try {
      await attio(token, "POST", "/objects/deals/attributes", { data: { title: spec.label, description: spec.description, api_slug: spec.name, type, is_required: false, is_unique: false, is_multiselect: false, config: {} } });
      if (type === "select") for (const title of Object.values(STATUS_TITLES)) await attio(token, "POST", `/objects/deals/attributes/${spec.name}/options`, { data: { title } }).catch(() => undefined);
      log.push({ at: at(), kind: "deal-attribute", name: spec.name, result: "created", detail: spec.label });
    } catch (error) {
      log.push({ at: at(), kind: "deal-attribute", name: spec.name, result: error instanceof AttioError && error.status === 409 ? "reused" : "failed", detail: error instanceof Error ? error.message : "" });
    }
  }
  if (!plan.statusExists) {
    try {
      await attio(token, "POST", "/objects/deals/attributes/stage/statuses", { data: { title: QC_DEAL_STATUS } });
      log.push({ at: at(), kind: "deal-stage", name: QC_DEAL_STATUS, result: "created", detail: "On Deals" });
    } catch (error) {
      log.push({ at: at(), kind: "deal-stage", name: QC_DEAL_STATUS, result: "failed", detail: error instanceof Error ? error.message : "" });
    }
  } else {
    log.push({ at: at(), kind: "deal-stage", name: QC_DEAL_STATUS, result: "reused", detail: "On Deals" });
  }
  return log;
}

type Stored = { deal_id: string | null; contact_id: string | null; company_id: string | null; note_id: string | null };
const recordId = (data: Row) => text(object(object(data.data).id).record_id);

async function findPerson(token: string, meeting: Row, linkedin: string): Promise<string | null> {
  const email = text(meeting.invitee_email).toLowerCase();
  for (const filter of [email ? { email_addresses: email } : null, linkedin ? { qc_linkedin_url: linkedin } : null]) {
    if (!filter) continue;
    const hit = list((await attio(token, "POST", "/objects/people/records/query", { filter, limit: 1 }).catch(() => ({} as Row))).data)[0];
    if (hit) return text(object(hit.id).record_id);
  }
  if (!email && !linkedin) return null;
  const [first, ...rest] = text(meeting.invitee_name).split(/\s+/);
  const made = await writeTolerant(token, "POST", "/objects/people/records", {
    name: [{ first_name: first ?? "", last_name: rest.join(" "), full_name: text(meeting.invitee_name) }],
    ...(email ? { email_addresses: [email] } : {}),
    ...(text(meeting.invitee_title) ? { job_title: text(meeting.invitee_title) } : {}),
    ...(linkedin ? { linkedin, qc_linkedin_url: linkedin } : {}),
  }).catch(() => null);
  return made ? recordId(made) || null : null;
}

async function findCompany(token: string, domain: string, name: string): Promise<string | null> {
  if (!domain) return null;
  const hit = list((await attio(token, "POST", "/objects/companies/records/query", { filter: { domains: domain }, limit: 1 }).catch(() => ({} as Row))).data)[0];
  if (hit) return text(object(hit.id).record_id);
  const made = await attio(token, "POST", "/objects/companies/records", { data: { values: { domains: [{ domain }], ...(name ? { name } : {}) } } }).catch(() => null);
  return made ? recordId(made) || null : null;
}

export async function attioPushMeetingDeal(token: string, destination: Destination, meeting: Row, stored: Stored | undefined, config: Config): Promise<Stored & { created: boolean }> {
  const plan = object(destination.plan) as unknown as AttioPlan & { deals?: AttioDealsPlan };
  if (!plan.deals?.enabled || !plan.deals.available) throw new Error("Booked meetings to deals is not built for this client.");
  const ownerId = plan.settings?.ownerId ?? null;
  const facts = await dealFacts(config, destination.workspace_id, meeting);
  const linkedin = canonicalLinkedin(text(meeting.invitee_linkedin)) || facts.reply?.linkedinCanonical || "";
  const domain = text(meeting.company_domain) || facts.reply?.domain || "";

  const values: Row = {};
  for (const [key, value] of Object.entries(facts.fields)) values[key] = key === "qc_meeting_status" ? STATUS_TITLES[String(value)] ?? "Scheduled" : value;

  const personId = stored?.contact_id ?? (await findPerson(token, meeting, linkedin));
  const companyId = stored?.company_id ?? (await findCompany(token, domain, text(meeting.company_name) || facts.reply?.company || ""));
  const links: Row = {
    ...(personId ? { associated_people: [{ target_object: "people", target_record_id: personId }] } : {}),
    ...(companyId ? { associated_company: [{ target_object: "companies", target_record_id: companyId }] } : {}),
  };

  let dealId = stored?.deal_id ?? null;
  let created = false;
  if (dealId) {
    // Never the stage or the owner on an update; the name only while it is still QC's own person-name fallback.
    const current = await attio(token, "GET", `/objects/deals/records/${dealId}`).catch((error) => (error instanceof AttioError && error.status === 404 ? null : Promise.reject(error)));
    if (current) {
      const currentName = text(object(list(object(object(current.data).values).name)[0]).value);
      const rename = currentName === text(meeting.invitee_name) && facts.name !== currentName ? { name: facts.name } : {};
      await writeTolerant(token, "PATCH", `/objects/deals/records/${dealId}`, { ...values, ...links, ...rename }, undefined, ["associated_company", "associated_people"]);
    } else {
      dealId = null;
    }
  }
  if (!dealId) {
    const made = await writeTolerant(token, "POST", "/objects/deals/records", {
      name: facts.name,
      stage: QC_DEAL_STATUS,
      ...(ownerId ? { owner: [{ referenced_actor_type: "workspace-member", referenced_actor_id: ownerId }] } : {}),
      ...values,
      ...links,
    }, undefined, ["associated_company", "associated_people"]);
    dealId = recordId(made);
    created = true;
  }

  // The meeting and QC's brief, one note on the deal, updated in place.
  const title = `Booked meeting · ${text(meeting.invitee_name) || facts.name}`;
  let noteId = stored?.note_id ?? "";
  if (noteId) {
    const ok = await attio(token, "PATCH", `/notes/${noteId}`, { data: { title, format: "plaintext", content: brief(meeting) } }).catch(() => null);
    if (!ok) noteId = "";
  }
  if (!noteId) {
    const note = await attio(token, "POST", "/notes", { data: { parent_object: "deals", parent_record_id: dealId, title, format: "plaintext", content: brief(meeting) } }).catch(() => null);
    noteId = note ? text(object(object(note.data).id).note_id) : "";
  }
  return { deal_id: dealId, contact_id: personId, company_id: companyId, note_id: noteId || null, created };
}
