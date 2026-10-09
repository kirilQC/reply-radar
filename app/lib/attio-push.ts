// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { conversationText, type Destination, type ReplyRecord } from "./crm-push";

/**
 * Replies into a client's Attio, the same connect → lay of the land → plan → build → push flow as HubSpot.
 *
 * Attio's model, used the Attio way: the person record stays clean (name, email, job title, LinkedIn and
 * company, filled only where empty, plus one hidden QC match key), and everything QC knows about the lead lives
 * on its entry in a "QC Growth" list shared with the whole workspace. The list is the QC-only table every member
 * sees in the sidebar (a list, unlike a saved view, can be created over the API), and being on it is the
 * attribution. The conversation is one note on the person, updated in place.
 *
 * Auth is a workspace API key (Workspace settings → Developers), kept server side like the HubSpot key.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const list = (value: unknown): Row[] => (Array.isArray(value) ? value.map(object) : []);

const BASE = "https://api.attio.com/v2";

export class AttioError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function attio(token: string, method: string, path: string, body?: unknown, attempt = 0): Promise<Row> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if ((response.status === 429 || response.status >= 500) && attempt < 4) {
    const wait = Number(response.headers.get("retry-after")) || 1.5 * (attempt + 1);
    await new Promise((resolve) => setTimeout(resolve, Math.min(10, wait) * 1000));
    return attio(token, method, path, body, attempt + 1);
  }
  if (response.status === 204) return {};
  const raw = await response.text().catch(() => "");
  let data: Row = {};
  try { const parsed = JSON.parse(raw); data = Array.isArray(parsed) ? { data: parsed } : object(parsed); } catch { data = { message: raw.slice(0, 300) }; }
  if (!response.ok) throw new AttioError(text(data.message) || `Attio answered ${response.status}.`, response.status);
  return data;
}

// ── Connect ─────────────────────────────────────────────────────────────────────────────────────

export const ATTIO_REQUIRED_SCOPES = ["record_permission:read-write", "object_configuration:read-write", "list_configuration:read-write", "list_entry:read-write", "note:read-write", "user_management:read"];

/** Which workspace a key belongs to, and what it may do. */
export async function attioConnect(token: string): Promise<{ workspaceId: string; name: string; slug: string; scopes: string[] }> {
  const self = await attio(token, "GET", "/self");
  if (self.active === false) throw new Error("That Attio key is not active.");
  return {
    workspaceId: text(self.workspace_id),
    name: text(self.workspace_name),
    slug: text(self.workspace_slug),
    scopes: text(self.scope).split(/\s+/).filter(Boolean),
  };
}

// ── Lay of the land ─────────────────────────────────────────────────────────────────────────────

export type AttioAttribute = { slug: string; title: string; type: string; unique: boolean; system: boolean };
export type AttioAudit = {
  at: string;
  contacts: number;
  companies: number;
  countsCapped: boolean;
  owners: Array<{ id: string; name: string; email: string }>;
  recentSources: Array<{ source: string; count: number }>;
  lookAlikes: Array<{ name: string; label: string; why: string }>;
  lists: Array<{ id: string; slug: string; name: string; parent: string }>;
  peopleAttributes: AttioAttribute[];
  qcList: { id: string; slug: string; name: string } | null;
  qcListAttributes: AttioAttribute[];
  scopes: string[];
  missingScopes: string[];
};

const attributeOf = (row: Row): AttioAttribute => ({ slug: text(row.api_slug), title: text(row.title), type: text(row.type), unique: row.is_unique === true, system: row.is_system_attribute === true });

/** Counts by paging the record query (Attio has no count endpoint), stopping at 2,000. */
async function countRecords(token: string, objectSlug: string): Promise<{ count: number; capped: boolean }> {
  let count = 0;
  for (let offset = 0; offset < 2000; offset += 500) {
    const page = list((await attio(token, "POST", `/objects/${objectSlug}/records/query`, { limit: 500, offset }).catch(() => ({} as Row))).data);
    count += page.length;
    if (page.length < 500) return { count, capped: false };
  }
  return { count, capped: true };
}

export const QC_LIST_NAME = "QC Growth";
export const QC_LIST_SLUG = "qc_growth";

export async function attioAudit(token: string, scopes: string[] = []): Promise<AttioAudit> {
  const [people, companies, peopleAttrs, memberRows, listRows] = await Promise.all([
    countRecords(token, "people"),
    countRecords(token, "companies"),
    attio(token, "GET", "/objects/people/attributes").then((data) => list(data.data)),
    attio(token, "GET", "/workspace_members").then((data) => list(data.data)).catch(() => [] as Row[]),
    attio(token, "GET", "/lists").then((data) => list(data.data)).catch(() => [] as Row[]),
  ]);
  const lists = listRows.map((row) => ({ id: text(object(row.id).list_id), slug: text(row.api_slug), name: text(row.name), parent: text(list(row.parent_object)[0] ?? row.parent_object) || text(row.parent_object) }));
  const qcList = lists.find((entry) => entry.slug === QC_LIST_SLUG) ?? lists.find((entry) => entry.name.trim().toLowerCase() === QC_LIST_NAME.toLowerCase()) ?? null;
  const qcListAttributes = qcList ? list((await attio(token, "GET", `/lists/${qcList.id}/attributes`).catch(() => ({} as Row))).data).map(attributeOf) : [];
  const peopleAttributes = peopleAttrs.map(attributeOf);
  const lookAlike = /campaign|sentiment|reply|outbound|heyreach|lemlist|qc[_ ]|source/i;
  return {
    at: new Date().toISOString(),
    contacts: people.count,
    companies: companies.count,
    countsCapped: people.capped || companies.capped,
    owners: memberRows.map((row) => ({ id: text(object(row.id).workspace_member_id), name: [text(row.first_name), text(row.last_name)].filter(Boolean).join(" ") || text(row.email_address), email: text(row.email_address) })),
    recentSources: [],
    lookAlikes: peopleAttributes.filter((attribute) => !attribute.system && !attribute.slug.startsWith("qc_") && (lookAlike.test(attribute.slug) || lookAlike.test(attribute.title))).map((attribute) => ({ name: attribute.slug, label: attribute.title, why: "Campaign or reply field" })),
    lists,
    peopleAttributes,
    qcList,
    qcListAttributes,
    scopes,
    missingScopes: scopes.length ? ATTIO_REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope)) : [],
  };
}

// ── Plan ────────────────────────────────────────────────────────────────────────────────────────

type AttributeSpec = { slug: string; title: string; type: "text" | "number" | "checkbox" | "timestamp" | "select" | "actor-reference"; description: string; unique?: boolean; options?: string[] };

/** The one QC field on the person: how a lead with no email still matches one record. */
export const QC_PERSON_ATTRIBUTES: AttributeSpec[] = [
  { slug: "qc_linkedin_url", title: "QC LinkedIn URL", type: "text", description: "The lead's LinkedIn profile, as QC Growth matches on it. Unique, so a lead with no email still matches one person.", unique: true },
];

/** The QC Growth list's columns: everything QC knows about the lead, kept off the person record. */
export const QC_LIST_ATTRIBUTES: AttributeSpec[] = [
  { slug: "qc_campaign", title: "Campaign", type: "text", description: "The QC Growth campaign the lead replied to." },
  { slug: "qc_sender", title: "Sender", type: "text", description: "Who the outreach came from." },
  { slug: "qc_outreach_platform", title: "Outreach platform", type: "select", description: "Where the outreach ran.", options: ["HeyReach", "lemlist", "Email Bison"] },
  { slug: "qc_reply_sentiment", title: "Reply sentiment", type: "select", description: "How the lead's latest reply reads.", options: ["Positive", "Neutral", "Negative"] },
  { slug: "qc_reply_count", title: "Replies", type: "number", description: "How many messages the lead has sent." },
  { slug: "qc_first_reply_date", title: "First reply", type: "timestamp", description: "When the lead first replied." },
  { slug: "qc_last_reply_date", title: "Last reply", type: "timestamp", description: "When the lead last replied." },
  { slug: "qc_booked_meeting", title: "Booked meeting", type: "checkbox", description: "Ticked when the lead has booked a meeting." },
  { slug: "qc_latest_reply", title: "Latest reply", type: "text", description: "The lead's most recent reply." },
  { slug: "qc_conversation", title: "Conversation", type: "text", description: "The whole conversation, oldest first, kept up to date." },
  { slug: "qc_linkedin", title: "LinkedIn", type: "text", description: "The lead's LinkedIn profile." },
  { slug: "qc_company_domain", title: "Company domain", type: "text", description: "The lead's company website." },
  { slug: "qc_company_linkedin", title: "Company LinkedIn", type: "text", description: "The company's LinkedIn page." },
  { slug: "qc_owner", title: "Owner", type: "actor-reference", description: "QC Growth, who brought the lead in." },
];

export const QC_OWNER_EMAIL = (process.env.QC_HUBSPOT_OWNER_EMAIL ?? "admin@qcgrowth.com").trim();
export function qcMemberOf(owners: Array<{ id: string; name: string; email: string }>) {
  return owners.find((owner) => owner.email.toLowerCase() === QC_OWNER_EMAIL.toLowerCase())
    ?? owners.find((owner) => /@qcgrowth\.com$/i.test(owner.email))
    ?? owners.find((owner) => /^qc\s*growth$/i.test(owner.name.trim()))
    ?? null;
}

export type AttioPlanItem = { id: string; kind: "list" | "property" | "list-attribute" | "standard" | "owner"; name: string; label: string; detail: string; action: "create" | "reuse" | "skip"; spec?: AttributeSpec };
export type AttioPlan = {
  at: string;
  items: AttioPlanItem[];
  settings: { leadSourceProperty: null; leadSourceValue: null; lifecycleOnCreate: null; ownerId: string | null; listId: string | null };
  conversation: string;
  notTouched: string[];
  warnings: string[];
};

export function attioPlan(audit: AttioAudit): AttioPlan {
  const items: AttioPlanItem[] = [];
  const warnings: string[] = [];
  if (audit.missingScopes.length) warnings.push(`The key is missing ${audit.missingScopes.join(", ")}. Edit it in Attio (Workspace settings → Developers) and re-read, or the build will fail.`);
  for (const [slug, label, from] of [["name", "Name", "Lead's full name"], ["email_addresses", "Email addresses", "Lead's email"], ["job_title", "Job title", "Lead's job title"], ["linkedin", "LinkedIn", "Lead's LinkedIn"], ["company", "Company", "Found or added by domain, with its LinkedIn page"]]) {
    items.push({ id: `standard:${slug}`, kind: "standard", name: slug, label, detail: `${from}. Attio's own field, filled in where empty.`, action: "reuse" });
  }
  const people = new Map(audit.peopleAttributes.map((attribute) => [attribute.slug, attribute]));
  for (const spec of QC_PERSON_ATTRIBUTES) {
    const existing = people.get(spec.slug);
    items.push(!existing
      ? { id: `property:${spec.slug}`, kind: "property", name: spec.slug, label: spec.title, detail: `${spec.description} On People.`, action: "create", spec }
      : existing.type === spec.type
        ? { id: `property:${spec.slug}`, kind: "property", name: spec.slug, label: existing.title, detail: "Already there, reused.", action: "reuse", spec }
        : { id: `property:${spec.slug}`, kind: "property", name: spec.slug, label: existing.title, detail: `Already exists as ${existing.type}; left alone.`, action: "skip", spec });
  }
  items.push(audit.qcList
    ? { id: "list", kind: "list", name: audit.qcList.slug, label: `List: ${audit.qcList.name}`, detail: "Already there, reused.", action: "reuse" }
    : { id: "list", kind: "list", name: QC_LIST_SLUG, label: `List: ${QC_LIST_NAME}`, detail: "A list of every person QC brings in, shared with the whole workspace, with QC's columns. It sits in the sidebar for everyone.", action: "create" });
  const onList = new Map(audit.qcListAttributes.map((attribute) => [attribute.slug, attribute]));
  for (const spec of QC_LIST_ATTRIBUTES) {
    const existing = onList.get(spec.slug);
    items.push(!existing
      ? { id: `list-attribute:${spec.slug}`, kind: "list-attribute", name: spec.slug, label: spec.title, detail: `${spec.description} A column on the QC Growth list.`, action: "create", spec }
      : existing.type === spec.type
        ? { id: `list-attribute:${spec.slug}`, kind: "list-attribute", name: spec.slug, label: existing.title, detail: "Already there, reused.", action: "reuse", spec }
        : { id: `list-attribute:${spec.slug}`, kind: "list-attribute", name: spec.slug, label: existing.title, detail: `Already exists as ${existing.type}; left alone.`, action: "skip", spec });
  }
  const member = qcMemberOf(audit.owners);
  items.push(member
    ? { id: "owner", kind: "owner", name: member.email || member.name, label: `Owner: ${member.name}`, detail: "QC Growth is the Owner on every list entry QC brings in.", action: "reuse" }
    : { id: "owner", kind: "owner", name: QC_OWNER_EMAIL, label: "Owner: QC Growth", detail: `No QC Growth member in this workspace; invite ${QC_OWNER_EMAIL} in Attio to set the Owner column.`, action: "skip" });
  return {
    at: new Date().toISOString(),
    items,
    settings: { leadSourceProperty: null, leadSourceValue: null, lifecycleOnCreate: null, ownerId: member?.id ?? null, listId: audit.qcList?.id ?? null },
    conversation: "Each conversation is one note on the person (LinkedIn or email, with campaign and sender), updated in place as it continues. The QC Growth list also carries it as a column.",
    notTouched: ["Existing lists, views, attributes and workflows", "People's existing names, emails, titles and companies (only empty ones are filled in)", "Deals and pipelines"],
    warnings,
  };
}

// ── Apply ───────────────────────────────────────────────────────────────────────────────────────

export type AttioBuildLogEntry = { at: string; kind: string; name: string; result: "created" | "reused" | "skipped" | "failed" | "verified"; detail: string };

function attributeBody(spec: AttributeSpec) {
  return { data: { title: spec.title, description: spec.description, api_slug: spec.slug, type: spec.type, is_required: false, is_unique: spec.unique === true, is_multiselect: false, config: {} } };
}

async function ensureOptions(token: string, base: string, spec: AttributeSpec) {
  if (!spec.options?.length) return;
  const have = new Set(list((await attio(token, "GET", `${base}/attributes/${spec.slug}/options`).catch(() => ({} as Row))).data).map((option) => text(option.title).toLowerCase()));
  for (const title of spec.options.filter((option) => !have.has(option.toLowerCase()))) {
    await attio(token, "POST", `${base}/attributes/${spec.slug}/options`, { data: { title } }).catch(() => undefined);
  }
}

export async function attioApply(token: string, plan: AttioPlan): Promise<AttioBuildLogEntry[]> {
  const log: AttioBuildLogEntry[] = [];
  const at = () => new Date().toISOString();
  const fail = (error: unknown) => (error instanceof Error ? error.message : "");

  for (const item of plan.items.filter((entry) => entry.kind === "property" && entry.action === "create" && entry.spec)) {
    try {
      await attio(token, "POST", "/objects/people/attributes", attributeBody(item.spec!));
      log.push({ at: at(), kind: "property", name: item.name, result: "created", detail: `${item.spec!.title} on People` });
    } catch (error) {
      log.push({ at: at(), kind: "property", name: item.name, result: error instanceof AttioError && error.status === 409 ? "reused" : "failed", detail: fail(error) });
    }
  }

  let listId = plan.settings.listId;
  if (!listId) {
    try {
      const created = await attio(token, "POST", "/lists", { data: { name: QC_LIST_NAME, api_slug: QC_LIST_SLUG, parent_object: "people", workspace_access: "full-access", workspace_member_access: [] } });
      listId = text(object(object(created.data).id).list_id);
      log.push({ at: at(), kind: "list", name: QC_LIST_SLUG, result: "created", detail: `${QC_LIST_NAME}, shared with the whole workspace` });
    } catch (error) {
      const found = list((await attio(token, "GET", "/lists").catch(() => ({} as Row))).data).find((row) => text(row.api_slug) === QC_LIST_SLUG);
      listId = found ? text(object(found.id).list_id) : null;
      log.push({ at: at(), kind: "list", name: QC_LIST_SLUG, result: listId ? "reused" : "failed", detail: listId ? QC_LIST_NAME : fail(error) });
    }
  }
  plan.settings.listId = listId;

  if (listId) {
    for (const item of plan.items.filter((entry) => entry.kind === "list-attribute" && entry.action !== "skip" && entry.spec)) {
      const spec = item.spec!;
      try {
        if (item.action === "create") {
          await attio(token, "POST", `/lists/${listId}/attributes`, attributeBody(spec)).catch((error) => {
            if (!(error instanceof AttioError && error.status === 409)) throw error;
          });
          log.push({ at: at(), kind: "list-attribute", name: spec.slug, result: "created", detail: spec.title });
        }
        await ensureOptions(token, `/lists/${listId}`, spec);
      } catch (error) {
        log.push({ at: at(), kind: "list-attribute", name: spec.slug, result: "failed", detail: fail(error) });
      }
    }
  }

  // Read back what the push will write.
  const people = new Map(list((await attio(token, "GET", "/objects/people/attributes")).data).map((row) => [text(row.api_slug), attributeOf(row)]));
  for (const spec of QC_PERSON_ATTRIBUTES) {
    const found = people.get(spec.slug);
    log.push({ at: at(), kind: "check", name: spec.slug, result: found && found.type === spec.type ? "verified" : "failed", detail: found ? `${found.title} (${found.type}${found.unique ? ", unique" : ""})` : "Not found after the build" });
  }
  if (listId) {
    const columns = new Map(list((await attio(token, "GET", `/lists/${listId}/attributes`)).data).map((row) => [text(row.api_slug), attributeOf(row)]));
    for (const spec of QC_LIST_ATTRIBUTES) {
      const found = columns.get(spec.slug);
      log.push({ at: at(), kind: "check", name: spec.slug, result: found && found.type === spec.type ? "verified" : "failed", detail: found ? `${found.title} (${found.type})` : "Not on the list after the build" });
    }
  }
  return log;
}

// ── Push ────────────────────────────────────────────────────────────────────────────────────────

/** Which QC Growth list columns the build left usable. */
function usableColumns(destination: Destination): Set<string> {
  const plan = object(destination.plan) as unknown as AttioPlan;
  return new Set((plan.items ?? []).filter((item) => item.kind === "list-attribute" && item.action !== "skip").map((item) => item.name));
}

const firstValue = (values: Row, slug: string): Row => object(list(values[slug])[0]);

export async function attioPush(
  token: string,
  destination: Destination,
  record: ReplyRecord,
  stored?: { contact_id: string | null; company_id: string | null; note_id: string | null; created_contact?: boolean },
): Promise<{ contactId: string; companyId: string | null; noteId: string; created: boolean }> {
  const plan = object(destination.plan) as unknown as AttioPlan;
  const listId = plan.settings?.listId;
  if (!listId) throw new Error("The QC Growth list has not been built yet.");
  const columns = usableColumns(destination);

  // The company first, by domain, so the person can point at it.
  let companyId: string | null = stored?.company_id ?? null;
  if (!companyId && record.domain) {
    const found = list((await attio(token, "POST", "/objects/companies/records/query", { filter: { domains: record.domain }, limit: 1 }).catch(() => ({} as Row))).data)[0];
    if (found) {
      companyId = text(object(found.id).record_id);
      const values = object(found.values);
      const fill: Row = {};
      if (record.companyLinkedinUrl && !text(firstValue(values, "linkedin").value)) fill.linkedin = record.companyLinkedinUrl;
      if (record.company && !text(firstValue(values, "name").value)) fill.name = record.company;
      if (Object.keys(fill).length) await attio(token, "PATCH", `/objects/companies/records/${companyId}`, { data: { values: fill } }).catch(() => undefined);
    } else {
      const created = await attio(token, "POST", "/objects/companies/records", { data: { values: { domains: [{ domain: record.domain }], ...(record.company ? { name: record.company } : {}), ...(record.companyLinkedinUrl ? { linkedin: record.companyLinkedinUrl } : {}) } } }).catch(() => null);
      companyId = created ? text(object(object(created.data).id).record_id) || null : null;
    }
  }

  // The person: the one we stored, else by email, else by QC LinkedIn URL.
  let personId = "";
  let current: Row = {};
  const getPerson = async (id: string) => object((await attio(token, "GET", `/objects/people/records/${id}`)).data);
  if (stored?.contact_id) {
    const found = await getPerson(stored.contact_id).catch(() => null);
    if (found && Object.keys(found).length) { personId = stored.contact_id; current = object(found.values); }
  }
  for (const filter of [record.email ? { email_addresses: record.email } : null, record.linkedinCanonical ? { qc_linkedin_url: record.linkedinCanonical } : null]) {
    if (personId || !filter) continue;
    const hit = list((await attio(token, "POST", "/objects/people/records/query", { filter, limit: 1 }).catch(() => ({} as Row))).data)[0];
    if (hit) { personId = text(object(hit.id).record_id); current = object(hit.values); }
  }

  const nameValue = [{ first_name: record.firstName, last_name: record.lastName, full_name: record.name }];
  let created = false;
  if (personId) {
    // The client's person: QC's match key always, their own fields only where empty, nothing else.
    const fill: Row = {};
    if (record.linkedinCanonical) fill.qc_linkedin_url = record.linkedinCanonical;
    if (record.name && !text(firstValue(current, "name").full_name)) fill.name = nameValue;
    if (record.email && !list(current.email_addresses).length) fill.email_addresses = [record.email];
    if (record.title && !text(firstValue(current, "job_title").value)) fill.job_title = record.title;
    if (record.linkedinUrl && !text(firstValue(current, "linkedin").value)) fill.linkedin = record.linkedinUrl;
    if (companyId && !text(firstValue(current, "company").target_record_id)) fill.company = [{ target_object: "companies", target_record_id: companyId }];
    if (Object.keys(fill).length) await attio(token, "PATCH", `/objects/people/records/${personId}`, { data: { values: fill } });
  } else {
    const values: Row = {
      name: nameValue,
      ...(record.email ? { email_addresses: [record.email] } : {}),
      ...(record.title ? { job_title: record.title } : {}),
      ...(record.linkedinUrl ? { linkedin: record.linkedinUrl } : {}),
      ...(record.linkedinCanonical ? { qc_linkedin_url: record.linkedinCanonical } : {}),
      ...(companyId ? { company: [{ target_object: "companies", target_record_id: companyId }] } : {}),
    };
    const made = await attio(token, "POST", "/objects/people/records", { data: { values } });
    personId = text(object(object(made.data).id).record_id);
    created = true;
  }
  created = created || Boolean(stored?.created_contact);

  // Its QC Growth list entry: found or added, QC's columns always written.
  const entry: Row = {};
  const put = (slug: string, value: unknown) => { if (columns.has(slug) && value !== "" && value !== null && value !== undefined) entry[slug] = value; };
  put("qc_campaign", record.campaign);
  put("qc_sender", record.sender);
  put("qc_outreach_platform", record.platform);
  if (["positive", "neutral", "negative"].includes(record.sentiment)) put("qc_reply_sentiment", record.sentiment[0].toUpperCase() + record.sentiment.slice(1));
  put("qc_reply_count", record.replyCount);
  put("qc_first_reply_date", record.firstReplyAt ? new Date(record.firstReplyAt).toISOString() : "");
  put("qc_last_reply_date", record.lastReplyAt ? new Date(record.lastReplyAt).toISOString() : "");
  put("qc_booked_meeting", record.bookedMeeting);
  put("qc_latest_reply", record.latestReply.slice(0, 5000));
  put("qc_conversation", conversationText(record, 60_000, "plain"));
  put("qc_linkedin", record.linkedinCanonical);
  put("qc_company_domain", record.domain);
  put("qc_company_linkedin", record.companyLinkedinUrl);
  if (plan.settings.ownerId) put("qc_owner", [{ referenced_actor_type: "workspace-member", referenced_actor_id: plan.settings.ownerId }]);
  await attio(token, "PUT", `/lists/${listId}/entries`, { data: { parent_record_id: personId, parent_object: "people", entry_values: entry } });

  // The conversation: one note, updated in place.
  const title = `${record.channel === "email" ? "Email" : "LinkedIn"} conversation · QC Growth`;
  const content = conversationText(record, 60_000, "markdown");
  let noteId = stored?.note_id ?? "";
  if (noteId) {
    const updated = await attio(token, "PATCH", `/notes/${noteId}`, { data: { title, format: "markdown", content } }).catch((error) => (error instanceof AttioError && error.status === 404 ? null : Promise.reject(error)));
    if (!updated) noteId = "";
  }
  if (!noteId) {
    noteId = text(object(object((await attio(token, "POST", "/notes", { data: { parent_object: "people", parent_record_id: personId, title, format: "markdown", content } })).data).id).note_id);
  }
  return { contactId: personId, companyId, noteId, created };
}
