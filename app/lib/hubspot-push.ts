// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * A client's replies into their HubSpot, as contacts attributed to QC Growth.
 *
 * The order is the one QC's /hubspot playbook uses (qc-growth-os wiki/prompts/hubspot.md): connect and check
 * the portal, read the lay of the land without writing anything, write a plan in plain English, build only
 * after a person approves it, read back what was built, then route. Nothing that already exists in the portal
 * is edited or deleted: the build only creates QC Growth's own fields (and, when the plan says so, adds a
 * "QC Growth" option to the client's lead source dropdown).
 *
 * ── Key ─────────────────────────────────────────────────────────────────────────────────────────
 * A service key (Development → Keys → Service keys, "pat-…") named "QC Growth", so HubSpot's own record
 * source on every contact we create reads QC Growth. Scopes: crm.objects.contacts.read/write,
 * crm.objects.companies.read/write, crm.schemas.contacts.read/write, crm.objects.owners.read.
 *
 * ── Contacts ────────────────────────────────────────────────────────────────────────────────────
 * Found by the contact id we stored, else by email, else by QC LinkedIn ID (a unique property we create,
 * because HubSpot cannot match on a LinkedIn URL and most LinkedIn leads have no email). A contact we create
 * gets everything; a contact the client already had only gets QC's fields and its empty basics filled, never
 * its lifecycle stage, lead source or owner changed. The conversation is one note per thread, updated in place.
 */

import { conversationText, type Destination, type ReplyRecord } from "./crm-push";

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const list = (value: unknown): Row[] => (Array.isArray(value) ? value.map(object) : []);

const BASE = "https://api.hubapi.com";

export class HubSpotError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/** One HubSpot call. 429s and 5xx are retried with backoff; other errors throw with HubSpot's own message. */
export async function hubspot(token: string, method: string, path: string, body?: unknown, attempt = 0): Promise<Row> {
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
    return hubspot(token, method, path, body, attempt + 1);
  }
  if (response.status === 204) return {};
  const raw = await response.text().catch(() => "");
  let data: Row = {};
  try { data = object(JSON.parse(raw)); } catch { data = { message: raw.slice(0, 300) }; }
  if (!response.ok) throw new HubSpotError(text(data.message) || `HubSpot answered ${response.status}.`, response.status);
  return data;
}

// ── Connect ─────────────────────────────────────────────────────────────────────────────────────

export async function hubspotConnect(token: string): Promise<{ portalId: string; name: string; timeZone: string; scopes: string[] }> {
  let details: Row;
  try {
    details = await hubspot(token, "GET", "/account-info/v3/details");
  } catch (error) {
    throw new HubSpotError(error instanceof HubSpotError && error.status === 401 ? "HubSpot did not accept that key." : `Could not reach HubSpot: ${error instanceof Error ? error.message : "unknown error"}`, error instanceof HubSpotError ? error.status : 0);
  }
  const portalId = text(details.portalId);
  const me = await hubspot(token, "GET", "/integrations/v1/me").catch(() => ({} as Row));
  // A service or private-app key can say which scopes it has; best effort, used to warn before the build fails.
  const info = await hubspot(token, "POST", "/oauth/v2/private-apps/get/access-token-info", { tokenKey: token }).catch(() => ({} as Row));
  return {
    portalId,
    name: text(me.hub_domain) || text(details.uiDomain) || `Portal ${portalId}`,
    timeZone: text(details.timeZone),
    scopes: (Array.isArray(info.scopes) ? info.scopes : []).map(text),
  };
}

export const REQUIRED_SCOPES = ["crm.objects.contacts.read", "crm.objects.contacts.write", "crm.objects.companies.read", "crm.objects.companies.write", "crm.schemas.contacts.read", "crm.schemas.contacts.write", "crm.objects.owners.read"];

// ── Audit (read only) ───────────────────────────────────────────────────────────────────────────

export type HubSpotProperty = { name: string; label: string; type: string; fieldType: string; groupName: string; hubspotDefined: boolean; readOnly: boolean; unique: boolean; options: Array<{ label: string; value: string }> };

export type HubSpotAudit = {
  at: string;
  contacts: number;
  companies: number;
  properties: HubSpotProperty[];
  groups: string[];
  owners: Array<{ id: string; name: string; email: string }>;
  recentSources: Array<{ source: string; count: number }>;
  lookAlikes: Array<{ name: string; label: string; type: string; why: string }>;
  leadSourceCandidates: Array<{ name: string; label: string; options: Array<{ label: string; value: string }> }>;
  lifecycleOptions: string[];
  scopes: string[];
  missingScopes: string[];
};

const propertyOf = (row: Row): HubSpotProperty => ({
  name: text(row.name),
  label: text(row.label),
  type: text(row.type),
  fieldType: text(row.fieldType),
  groupName: text(row.groupName),
  hubspotDefined: row.hubspotDefined === true,
  readOnly: object(row.modificationMetadata).readOnlyValue === true,
  unique: row.hasUniqueValue === true,
  options: list(row.options).map((option) => ({ label: text(option.label), value: text(option.value) })),
});

export async function hubspotAudit(token: string, scopes: string[] = []): Promise<HubSpotAudit> {
  const count = async (objectType: string) => Number((await hubspot(token, "POST", `/crm/v3/objects/${objectType}/search`, { limit: 1, properties: ["hs_object_id"] }).catch(() => ({} as Row))).total) || 0;
  const [contacts, companies, propertyRows, groupRows, ownerRows, recent] = await Promise.all([
    count("contacts"),
    count("companies"),
    hubspot(token, "GET", "/crm/v3/properties/contacts").then((data) => list(data.results)),
    hubspot(token, "GET", "/crm/v3/properties/contacts/groups").then((data) => list(data.results)).catch(() => [] as Row[]),
    hubspot(token, "GET", "/crm/v3/owners?limit=100").then((data) => list(data.results)).catch(() => [] as Row[]),
    hubspot(token, "POST", "/crm/v3/objects/contacts/search", { limit: 100, sorts: [{ propertyName: "createdate", direction: "DESCENDING" }], properties: ["hs_object_source_label", "hs_object_source", "hs_object_source_detail_1"] }).then((data) => list(data.results)).catch(() => [] as Row[]),
  ]);
  const properties = propertyRows.map(propertyOf);
  const sources = new Map<string, number>();
  for (const contact of recent) {
    const props = object(contact.properties);
    const label = text(props.hs_object_source_detail_1) || text(props.hs_object_source_label) || text(props.hs_object_source) || "Unknown";
    sources.set(label, (sources.get(label) ?? 0) + 1);
  }
  const lookAlike = /linkedin|lead.?source|campaign|sentiment|reply|outbound|qc[_ ]|heyreach|lemlist/i;
  const lookAlikes = properties
    .filter((p) => !p.hubspotDefined && !p.name.startsWith("qc_") && (lookAlike.test(p.name) || lookAlike.test(p.label)))
    .map((p) => ({ name: p.name, label: p.label, type: p.type, why: /linkedin/i.test(p.name + p.label) ? "LinkedIn field" : /source/i.test(p.name + p.label) ? "Source field" : "Campaign or reply field" }));
  const leadSourceCandidates = properties
    .filter((p) => p.type === "enumeration" && !p.readOnly && !/^hs_(analytics|latest|object)_source/.test(p.name) && /lead.?source|contact.?source|^source$|^lead_source/i.test(`${p.name} ${p.label}`))
    .map((p) => ({ name: p.name, label: p.label, options: p.options }));
  const lifecycle = properties.find((p) => p.name === "lifecyclestage");
  return {
    at: new Date().toISOString(),
    contacts,
    companies,
    properties,
    groups: groupRows.map((group) => text(group.name)),
    owners: ownerRows.map((owner) => ({ id: text(owner.id), name: [text(owner.firstName), text(owner.lastName)].filter(Boolean).join(" ") || text(owner.email), email: text(owner.email) })),
    recentSources: [...sources].map(([source, n]) => ({ source, count: n })).sort((a, b) => b.count - a.count),
    lookAlikes,
    leadSourceCandidates,
    lifecycleOptions: (lifecycle?.options ?? []).map((option) => option.value),
    scopes,
    missingScopes: scopes.length ? REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope)) : [],
  };
}

// ── Plan ────────────────────────────────────────────────────────────────────────────────────────

export const QC_GROUP = { name: "qc_growth", label: "QC Growth" };

type PropertySpec = { name: string; label: string; type: string; fieldType: string; description: string; options?: Array<{ label: string; value: string }>; unique?: boolean };

/** QC Growth's fields on a contact. The group keeps them together on the record. */
export const QC_PROPERTIES: PropertySpec[] = [
  { name: "qc_source", label: "QC Growth source", type: "enumeration", fieldType: "select", description: "Set when QC Growth's outreach produced this reply.", options: [{ label: "QC Growth", value: "qc_growth" }] },
  { name: "qc_linkedin_id", label: "QC LinkedIn ID", type: "string", fieldType: "text", description: "The lead's LinkedIn profile id, used by QC Growth to match contacts without an email.", unique: true },
  { name: "qc_linkedin_url", label: "QC LinkedIn URL", type: "string", fieldType: "text", description: "The lead's LinkedIn profile." },
  { name: "qc_campaign", label: "QC campaign", type: "string", fieldType: "text", description: "The QC Growth campaign the lead replied to." },
  { name: "qc_sender", label: "QC sender", type: "string", fieldType: "text", description: "Who the outreach came from." },
  { name: "qc_reply_channel", label: "QC reply channel", type: "enumeration", fieldType: "select", description: "Where the lead replied.", options: [{ label: "LinkedIn", value: "linkedin" }, { label: "Email", value: "email" }] },
  { name: "qc_reply_sentiment", label: "QC reply sentiment", type: "enumeration", fieldType: "select", description: "How the lead's latest reply reads.", options: [{ label: "Positive", value: "positive" }, { label: "Neutral", value: "neutral" }, { label: "Negative", value: "negative" }] },
  { name: "qc_first_reply_date", label: "QC first reply", type: "datetime", fieldType: "date", description: "When the lead first replied to QC Growth's outreach." },
  { name: "qc_last_reply_date", label: "QC last reply", type: "datetime", fieldType: "date", description: "When the lead last replied." },
  { name: "qc_reply_count", label: "QC replies", type: "number", fieldType: "number", description: "How many messages the lead has sent." },
  { name: "qc_latest_reply", label: "QC latest reply", type: "string", fieldType: "textarea", description: "The lead's latest message." },
];

export type PlanItem = { id: string; kind: "group" | "property" | "option"; name: string; label: string; detail: string; action: "create" | "reuse" | "skip"; spec?: PropertySpec; property?: string; optionLabel?: string };
export type HubSpotPlan = {
  at: string;
  items: PlanItem[];
  settings: { leadSourceProperty: string | null; leadSourceValue: string | null; lifecycleOnCreate: string | null; ownerId: string | null };
  conversation: string;
  notTouched: string[];
  warnings: string[];
};

export function hubspotPlan(audit: HubSpotAudit): HubSpotPlan {
  const items: PlanItem[] = [];
  const warnings: string[] = [];
  if (audit.missingScopes.length) warnings.push(`The key is missing ${audit.missingScopes.join(", ")}. Edit the key in HubSpot (Development → Keys) and tick them, or the build will fail.`);
  items.push(audit.groups.includes(QC_GROUP.name)
    ? { id: "group", kind: "group", name: QC_GROUP.name, label: QC_GROUP.label, detail: "Already there, reused.", action: "reuse" }
    : { id: "group", kind: "group", name: QC_GROUP.name, label: QC_GROUP.label, detail: "A field group on contacts that holds QC Growth's fields together.", action: "create" });
  const byName = new Map(audit.properties.map((p) => [p.name, p]));
  for (const spec of QC_PROPERTIES) {
    const existing = byName.get(spec.name);
    if (!existing) {
      items.push({ id: `property:${spec.name}`, kind: "property", name: spec.name, label: spec.label, detail: `${spec.description}${spec.unique ? " Unique, so no two contacts can share it." : ""}`, action: "create", spec });
    } else if (existing.type === spec.type) {
      items.push({ id: `property:${spec.name}`, kind: "property", name: spec.name, label: existing.label, detail: "Already there with the right type, reused.", action: "reuse", spec });
    } else {
      items.push({ id: `property:${spec.name}`, kind: "property", name: spec.name, label: existing.label, detail: `A field with this name already exists as ${existing.type}, not ${spec.type}. Left alone; this field will not be filled.`, action: "skip", spec });
      warnings.push(`"${spec.name}" already exists with a different type, so it is skipped.`);
    }
  }
  // Attribution on the client's own lead source dropdown, when they have one.
  const leadSource = audit.leadSourceCandidates[0] ?? null;
  if (leadSource) {
    const existingOption = leadSource.options.find((option) => /qc growth/i.test(option.label));
    const has = Boolean(existingOption);
    items.push({ id: `option:${leadSource.name}`, kind: "option", name: leadSource.name, label: leadSource.label, detail: has ? `Your "${leadSource.label}" field already has a "QC Growth" option; contacts QC creates get it.` : `Add a "QC Growth" option to your "${leadSource.label}" field; contacts QC creates get it. Existing options are not changed.`, action: has ? "reuse" : "create", property: leadSource.name, optionLabel: "QC Growth" });
  }
  const lifecycle = audit.lifecycleOptions.includes("lead") ? "lead" : null;
  return {
    at: new Date().toISOString(),
    items,
    // The option's stored value: the client's own when they already had a QC Growth option, else ours.
    settings: { leadSourceProperty: leadSource?.name ?? null, leadSourceValue: leadSource ? leadSource.options.find((option) => /qc growth/i.test(option.label))?.value ?? "qc_growth" : null, lifecycleOnCreate: lifecycle, ownerId: null },
    conversation: "Each conversation is logged as one note on the contact's timeline (LinkedIn or email, with campaign and sender), updated in place as the conversation continues.",
    notTouched: [
      "Existing fields, workflows, pipelines, lists and views",
      "Lifecycle stage, lead status, owner and lead source of contacts that already exist",
      "Contacts' existing names, titles and companies (only empty ones are filled in)",
      "Deals",
    ],
    warnings,
  };
}

// ── Apply ───────────────────────────────────────────────────────────────────────────────────────

export type BuildLogEntry = { at: string; kind: string; name: string; result: "created" | "reused" | "skipped" | "failed" | "verified"; detail: string };

export async function hubspotApply(token: string, plan: HubSpotPlan): Promise<BuildLogEntry[]> {
  const log: BuildLogEntry[] = [];
  const at = () => new Date().toISOString();
  const group = plan.items.find((item) => item.kind === "group");
  if (group?.action === "create") {
    try {
      await hubspot(token, "POST", "/crm/v3/properties/contacts/groups", { name: QC_GROUP.name, label: QC_GROUP.label, displayOrder: -1 });
      log.push({ at: at(), kind: "group", name: QC_GROUP.name, result: "created", detail: QC_GROUP.label });
    } catch (error) {
      log.push({ at: at(), kind: "group", name: QC_GROUP.name, result: error instanceof HubSpotError && error.status === 409 ? "reused" : "failed", detail: error instanceof Error ? error.message : "" });
    }
  }
  const toCreate = plan.items.filter((item) => item.kind === "property" && item.action === "create" && item.spec);
  for (const item of toCreate) {
    const spec = item.spec!;
    try {
      await hubspot(token, "POST", "/crm/v3/properties/contacts", {
        name: spec.name,
        label: spec.label,
        type: spec.type,
        fieldType: spec.fieldType,
        groupName: QC_GROUP.name,
        description: spec.description,
        ...(spec.options ? { options: spec.options.map((option, index) => ({ ...option, displayOrder: index })) } : {}),
        ...(spec.unique ? { hasUniqueValue: true } : {}),
      });
      log.push({ at: at(), kind: "property", name: spec.name, result: "created", detail: spec.label });
    } catch (error) {
      log.push({ at: at(), kind: "property", name: spec.name, result: error instanceof HubSpotError && error.status === 409 ? "reused" : "failed", detail: error instanceof Error ? error.message : "" });
    }
  }
  for (const item of plan.items.filter((entry) => entry.kind === "option" && entry.action === "create" && entry.property)) {
    try {
      const current = propertyOf(await hubspot(token, "GET", `/crm/v3/properties/contacts/${encodeURIComponent(item.property!)}`));
      if (!current.options.some((option) => /qc growth/i.test(option.label))) {
        const options = [...current.options.map((option, index) => ({ ...option, displayOrder: index })), { label: "QC Growth", value: "qc_growth", displayOrder: current.options.length }];
        await hubspot(token, "PATCH", `/crm/v3/properties/contacts/${encodeURIComponent(item.property!)}`, { options });
      }
      log.push({ at: at(), kind: "option", name: `${item.property} = QC Growth`, result: "created", detail: item.label });
    } catch (error) {
      log.push({ at: at(), kind: "option", name: `${item.property} = QC Growth`, result: "failed", detail: error instanceof Error ? error.message : "" });
    }
  }
  // Read back every field the routing will write, and say what is really there.
  const after = new Map(list((await hubspot(token, "GET", "/crm/v3/properties/contacts")).results).map((row) => [text(row.name), propertyOf(row)]));
  for (const item of plan.items.filter((entry) => entry.kind === "property" && entry.action !== "skip" && entry.spec)) {
    const found = after.get(item.spec!.name);
    const ok = found && found.type === item.spec!.type && (!item.spec!.unique || found.unique);
    log.push({ at: at(), kind: "check", name: item.spec!.name, result: ok ? "verified" : "failed", detail: ok ? `${found!.label} (${found!.type})` : found ? `There as ${found.type}${item.spec!.unique && !found.unique ? ", not unique" : ""}` : "Not found after the build" });
  }
  return log;
}

// ── Push ────────────────────────────────────────────────────────────────────────────────────────

const CONTACT_BASICS = ["email", "firstname", "lastname", "jobtitle", "company", "city"];

/** Which QC fields the build left usable (a field skipped for a type clash is never written). */
function usableFields(destination: Destination): Set<string> {
  const plan = object(destination.plan) as unknown as HubSpotPlan;
  return new Set((plan.items ?? []).filter((item) => item.kind === "property" && item.action !== "skip").map((item) => item.name));
}

export async function hubspotPush(
  token: string,
  destination: Destination,
  record: ReplyRecord,
  stored?: { contact_id: string | null; company_id: string | null; note_id: string | null; created_contact?: boolean },
): Promise<{ contactId: string; companyId: string | null; noteId: string; created: boolean }> {
  const plan = object(destination.plan) as unknown as HubSpotPlan;
  const settings = plan.settings ?? { leadSourceProperty: null, leadSourceValue: null, lifecycleOnCreate: null, ownerId: null };
  const usable = usableFields(destination);
  const qc: Row = {};
  const put = (name: string, value: unknown) => { if (usable.has(name) && value !== "" && value !== null && value !== undefined) qc[name] = value; };
  put("qc_source", "qc_growth");
  put("qc_linkedin_id", record.linkedinId);
  put("qc_linkedin_url", record.linkedinUrl);
  put("qc_campaign", record.campaign);
  put("qc_sender", record.sender);
  put("qc_reply_channel", record.channel);
  if (["positive", "neutral", "negative"].includes(record.sentiment)) put("qc_reply_sentiment", record.sentiment);
  put("qc_first_reply_date", record.firstReplyAt ? new Date(record.firstReplyAt).toISOString() : "");
  put("qc_last_reply_date", record.lastReplyAt ? new Date(record.lastReplyAt).toISOString() : "");
  put("qc_reply_count", record.replyCount);
  put("qc_latest_reply", record.latestReply.slice(0, 60_000));
  const basics: Row = { email: record.email, firstname: record.firstName, lastname: record.lastName, jobtitle: record.title, company: record.company };

  // Find the contact: the one we stored, else by email, else by QC LinkedIn ID.
  let contactId = "";
  if (stored?.contact_id) {
    const found = await hubspot(token, "GET", `/crm/v3/objects/contacts/${encodeURIComponent(stored.contact_id)}?properties=${CONTACT_BASICS.join(",")}`).catch(() => null);
    if (found) contactId = text(found.id);
  }
  if (!contactId) {
    const filterGroups = [
      ...(record.email ? [{ filters: [{ propertyName: "email", operator: "EQ", value: record.email }] }] : []),
      ...(record.linkedinId && usable.has("qc_linkedin_id") ? [{ filters: [{ propertyName: "qc_linkedin_id", operator: "EQ", value: record.linkedinId }] }] : []),
    ];
    if (filterGroups.length) {
      const hit = list((await hubspot(token, "POST", "/crm/v3/objects/contacts/search", { filterGroups, limit: 1, properties: CONTACT_BASICS })).results)[0];
      if (hit) contactId = text(hit.id);
    }
  }

  let created = false;
  if (contactId) {
    // The client's contact: QC's fields always, their basics only where empty, nothing else.
    const current = object((await hubspot(token, "GET", `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${CONTACT_BASICS.join(",")}`)).properties);
    const fill: Row = {};
    for (const [name, value] of Object.entries(basics)) if (value && !text(current[name])) fill[name] = value;
    await hubspot(token, "PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { properties: { ...fill, ...qc } });
  } else {
    const properties: Row = { ...Object.fromEntries(Object.entries(basics).filter(([, value]) => value)), ...qc };
    if (settings.leadSourceProperty && settings.leadSourceValue) {
      const option = plan.items.find((item) => item.kind === "option" && item.property === settings.leadSourceProperty);
      if (option && option.action !== "skip") properties[settings.leadSourceProperty] = settings.leadSourceValue;
    }
    if (settings.lifecycleOnCreate) properties.lifecyclestage = settings.lifecycleOnCreate;
    if (settings.ownerId) properties.hubspot_owner_id = settings.ownerId;
    try {
      contactId = text((await hubspot(token, "POST", "/crm/v3/objects/contacts", { properties })).id);
      created = true;
    } catch (error) {
      // Created elsewhere a moment ago (search lags behind writes): HubSpot names the existing id.
      const existing = /Existing ID:\s*(\d+)/i.exec(error instanceof Error ? error.message : "")?.[1];
      if (!existing) throw error;
      contactId = existing;
      await hubspot(token, "PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { properties: qc });
    }
  }
  created = created || Boolean(stored?.created_contact);

  // The company, by domain: found or created, then associated (adding an association twice is harmless).
  let companyId: string | null = stored?.company_id ?? null;
  if (!companyId && record.domain) {
    const hit = list((await hubspot(token, "POST", "/crm/v3/objects/companies/search", { filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: record.domain }] }], limit: 1, properties: ["domain", "name"] }).catch(() => ({} as Row))).results)[0];
    companyId = hit ? text(hit.id) : text((await hubspot(token, "POST", "/crm/v3/objects/companies", { properties: { domain: record.domain, ...(record.company ? { name: record.company } : {}) } }).catch(() => ({} as Row))).id) || null;
  }
  if (companyId) await hubspot(token, "PUT", `/crm/v4/objects/contact/${encodeURIComponent(contactId)}/associations/default/company/${encodeURIComponent(companyId)}`).catch(() => undefined);

  // The conversation: one note, updated in place.
  const noteProperties = { hs_note_body: conversationText(record, 60_000, "html"), hs_timestamp: new Date(record.lastMessageAt || record.lastReplyAt || Date.now()).toISOString() };
  let noteId = stored?.note_id ?? "";
  if (noteId) {
    const updated = await hubspot(token, "PATCH", `/crm/v3/objects/notes/${encodeURIComponent(noteId)}`, { properties: noteProperties }).catch((error) => (error instanceof HubSpotError && error.status === 404 ? null : Promise.reject(error)));
    if (!updated) noteId = "";
  }
  if (!noteId) {
    noteId = text((await hubspot(token, "POST", "/crm/v3/objects/notes", {
      properties: noteProperties,
      associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
    })).id);
  }
  return { contactId, companyId, noteId, created };
}
