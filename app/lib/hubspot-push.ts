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
  try { const parsed = JSON.parse(raw); data = Array.isArray(parsed) ? { results: parsed } : object(parsed); } catch { data = { message: raw.slice(0, 300) }; }
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
  /** QC Growth's saved view and segment, when an earlier build made them. */
  qcView: { id: string; name: string } | null;
  qcSegment: { id: string; name: string } | null;
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
  const [contacts, companies, propertyRows, groupRows, ownerRows, recent, viewRows, segmentRows] = await Promise.all([
    count("contacts"),
    count("companies"),
    hubspot(token, "GET", "/crm/v3/properties/contacts").then((data) => list(data.results)),
    hubspot(token, "GET", "/crm/v3/properties/contacts/groups").then((data) => list(data.results)).catch(() => [] as Row[]),
    hubspot(token, "GET", "/crm/v3/owners?limit=100").then((data) => list(data.results)).catch(() => [] as Row[]),
    hubspot(token, "POST", "/crm/v3/objects/contacts/search", { limit: 100, sorts: [{ propertyName: "createdate", direction: "DESCENDING" }], properties: ["hs_object_source_label", "hs_object_source", "hs_object_source_detail_1"] }).then((data) => list(data.results)).catch(() => [] as Row[]),
    hubspot(token, "GET", QC_VIEW_PATH).then(viewList).catch(() => [] as Row[]),
    hubspot(token, "POST", "/crm/v3/lists/search", { query: QC_VIEW_NAME, count: 50 }).then((data) => list(data.lists)).catch(() => [] as Row[]),
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
    qcView: named(viewRows, "id"),
    qcSegment: named(segmentRows, "listId"),
  };
}

// The contacts saved view and segment holding only QC Growth's contacts, so the client's own Contacts tab is
// never flooded. Views go through HubSpot's CLI backend (the only API for saved views; it takes a service key),
// segments through the public Lists API. Filter: QC outreach platform is set, which only QC's push writes.
export const QC_VIEW_NAME = "QC Growth";
const QC_VIEW_PATH = "/hub/cli/backend/crm/contacts/views";
const QC_PLATFORMS = ["heyreach", "lemlist", "email_bison"];
const QC_VIEW_COLUMNS = ["firstname", "lastname", "email", "jobtitle", "company", "website", "qc_linkedin_url", "qc_company_linkedin_url", "qc_campaign", "qc_sender", "qc_outreach_platform", "qc_reply_sentiment", "qc_reply_count", "qc_last_reply_date", "hubspot_owner_id"];
const viewList = (data: unknown): Row[] => Array.isArray(data) ? data as Row[] : list(object(data).results ?? object(data).views ?? object(data).data);
function named(rows: Row[], idKey: string) {
  const row = rows.find((entry) => text(entry.name).trim().toLowerCase() === QC_VIEW_NAME.toLowerCase());
  return row ? { id: text(row[idKey] ?? row.id), name: text(row.name) } : null;
}
export function qcViewBody() {
  return { name: QC_VIEW_NAME, objectTypeId: "contacts", columns: QC_VIEW_COLUMNS.map((name) => ({ name })), filterGroups: [{ filters: [{ property: "qc_outreach_platform", operator: "IN", values: QC_PLATFORMS }] }], sort: { property: "qc_last_reply_date", direction: "DESCENDING" } };
}
export function qcSegmentBody() {
  return { name: QC_VIEW_NAME, objectTypeId: "0-1", processingType: "DYNAMIC", filterBranch: { filterBranchType: "OR", filters: [], filterBranches: [{ filterBranchType: "AND", filterBranches: [], filters: [{ filterType: "PROPERTY", property: "qc_outreach_platform", operation: { operationType: "ENUMERATION", operator: "IS_ANY_OF", values: QC_PLATFORMS } }] }] } };
}

// ── Plan ────────────────────────────────────────────────────────────────────────────────────────

export const QC_GROUP = { name: "qc_growth", label: "QC Growth" };

type PropertySpec = { name: string; label: string; type: string; fieldType: string; description: string; options?: Array<{ label: string; value: string }>; unique?: boolean };

/**
 * QC Growth's own fields on a contact, kept to the few HubSpot has no standard field for. Everything else
 * (name, email, title, company, domain, company LinkedIn page) goes into HubSpot's standard fields, and
 * channel, sender and the conversation itself live in the timeline note.
 */
export const QC_PROPERTIES: PropertySpec[] = [
  { name: "qc_linkedin_url", label: "QC LinkedIn URL", type: "string", fieldType: "text", description: "The lead's LinkedIn profile. Unique, so a lead with no email still matches one contact.", unique: true },
  { name: "qc_company_linkedin_url", label: "QC company LinkedIn", type: "string", fieldType: "text", description: "The company's LinkedIn page, on the contact so it can be a column in the QC Growth view." },
  { name: "qc_campaign", label: "QC campaign", type: "string", fieldType: "text", description: "The QC Growth campaign the lead replied to." },
  { name: "qc_sender", label: "QC sender", type: "string", fieldType: "text", description: "Who the outreach came from." },
  { name: "qc_outreach_platform", label: "QC outreach platform", type: "enumeration", fieldType: "select", description: "Where the outreach ran.", options: [{ label: "HeyReach", value: "heyreach" }, { label: "lemlist", value: "lemlist" }, { label: "Email Bison", value: "email_bison" }] },
  { name: "qc_first_reply_date", label: "QC first reply", type: "datetime", fieldType: "date", description: "When the lead first replied to QC Growth's outreach." },
  { name: "qc_last_reply_date", label: "QC last reply", type: "datetime", fieldType: "date", description: "When the lead last replied." },
  { name: "qc_reply_sentiment", label: "QC reply sentiment", type: "enumeration", fieldType: "select", description: "How the lead's latest reply reads.", options: [{ label: "Positive", value: "positive" }, { label: "Neutral", value: "neutral" }, { label: "Negative", value: "negative" }] },
  { name: "qc_reply_count", label: "QC replies", type: "number", fieldType: "number", description: "How many messages the lead has sent." },
];
/** Attribution when the client has no lead source dropdown to put "QC Growth" in. */
export const QC_SOURCE_PROPERTY: PropertySpec = { name: "qc_source", label: "QC Growth source", type: "enumeration", fieldType: "select", description: "Set on contacts QC Growth's outreach brought in.", options: [{ label: "QC Growth", value: "qc_growth" }] };

/** The standard HubSpot fields the push fills, shown on the plan so it is clear where everything lands. */
export const STANDARD_FIELDS: Array<{ object: "contact" | "company"; name: string; label: string; from: string }> = [
  { object: "contact", name: "firstname", label: "First name", from: "Lead's full name (first part)" },
  { object: "contact", name: "lastname", label: "Last name", from: "Lead's full name (rest)" },
  { object: "contact", name: "email", label: "Email", from: "Lead's email address" },
  { object: "contact", name: "jobtitle", label: "Job title", from: "Lead's job title" },
  { object: "contact", name: "company", label: "Company name", from: "Lead's company" },
  { object: "contact", name: "website", label: "Website URL", from: "Company domain" },
  { object: "company", name: "name", label: "Company name", from: "Lead's company" },
  { object: "company", name: "domain", label: "Company domain name", from: "Company domain" },
  { object: "company", name: "linkedin_company_page", label: "LinkedIn company page", from: "Company's LinkedIn page" },
];

/**
 * The QC Growth user in the client's HubSpot, who owns every contact QC brings in (the attribution: our leads
 * are never assigned to the client's people). Matched by name "QC Growth" or a qcgrowth.com address.
 */
export const QC_OWNER_EMAIL = (process.env.QC_HUBSPOT_OWNER_EMAIL ?? "admin@qcgrowth.com").trim();
export function qcOwnerOf(owners: Array<{ id: string; name: string; email: string }>) {
  return owners.find((owner) => /^qc\s*growth$/i.test(owner.name.trim()))
    ?? owners.find((owner) => owner.email.toLowerCase() === QC_OWNER_EMAIL.toLowerCase())
    ?? owners.find((owner) => /@qcgrowth\.com$/i.test(owner.email))
    ?? null;
}

export type PlanItem = { id: string; kind: "group" | "property" | "option" | "standard" | "owner" | "view" | "segment"; name: string; label: string; detail: string; action: "create" | "reuse" | "skip"; spec?: PropertySpec; property?: string; optionLabel?: string };
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
  if (audit.missingScopes.length) {
    const companies = audit.missingScopes.filter((scope) => scope.includes("companies"));
    const rest = audit.missingScopes.filter((scope) => !scope.includes("companies"));
    if (rest.length) warnings.push(`The key is missing ${rest.join(", ")}. Edit the key in HubSpot (Development → Keys) and tick them, or the build will fail.`);
    if (companies.length) warnings.push(`The key is missing ${companies.join(", ")}, so companies (name, domain, LinkedIn page) cannot be created or linked. Edit the key in HubSpot (Development → Keys) and tick them before pushing.`);
  }
  items.push(audit.groups.includes(QC_GROUP.name)
    ? { id: "group", kind: "group", name: QC_GROUP.name, label: QC_GROUP.label, detail: "Already there, reused.", action: "reuse" }
    : { id: "group", kind: "group", name: QC_GROUP.name, label: QC_GROUP.label, detail: "A field group on contacts that holds QC Growth's fields together.", action: "create" });
  for (const field of STANDARD_FIELDS) {
    items.push({ id: `standard:${field.object}:${field.name}`, kind: "standard", name: field.name, label: `${field.object === "company" ? "Company · " : ""}${field.label}`, detail: `${field.from}. HubSpot's own field, filled in where empty.`, action: "reuse" });
  }
  const byName = new Map(audit.properties.map((p) => [p.name, p]));
  // Attribution: the client's lead source dropdown when they have one, else our own one-option field.
  const leadSource = audit.leadSourceCandidates[0] ?? null;
  for (const spec of leadSource ? QC_PROPERTIES : [...QC_PROPERTIES, QC_SOURCE_PROPERTY]) {
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
  if (leadSource) {
    const existingOption = leadSource.options.find((option) => /qc growth/i.test(option.label));
    const has = Boolean(existingOption);
    items.push({ id: `option:${leadSource.name}`, kind: "option", name: leadSource.name, label: leadSource.label, detail: has ? `Your "${leadSource.label}" field already has a "QC Growth" option; contacts QC creates get it.` : `Add a "QC Growth" option to your "${leadSource.label}" field; contacts QC creates get it. Existing options are not changed.`, action: has ? "reuse" : "create", property: leadSource.name, optionLabel: "QC Growth" });
  }
  const lifecycle = audit.lifecycleOptions.includes("lead") ? "lead" : null;
  // Owner: the QC Growth user, found or created. Creating one needs settings.users.write on the key, and
  // HubSpot emails QC_OWNER_EMAIL an invite (a HubSpot user, free on any plan without a paid seat).
  const qcOwner = qcOwnerOf(audit.owners);
  items.push(qcOwner
    ? { id: "owner", kind: "owner", name: qcOwner.email || qcOwner.name, label: `Owner: ${qcOwner.name}`, detail: "Your QC Growth user owns every contact QC brings in.", action: "reuse" }
    : { id: "owner", kind: "owner", name: QC_OWNER_EMAIL, label: "Owner: QC Growth", detail: `Add a HubSpot user "QC Growth" (${QC_OWNER_EMAIL}) to own every contact QC brings in. HubSpot emails that address an invite.`, action: "create" });
  items.push(audit.qcView
    ? { id: "view", kind: "view", name: audit.qcView.id, label: `Contacts view: ${QC_VIEW_NAME}`, detail: "Already there, reused.", action: "reuse" }
    : { id: "view", kind: "view", name: QC_VIEW_NAME, label: `Contacts view: ${QC_VIEW_NAME}`, detail: "A saved view in Contacts showing only the contacts QC brings in, newest reply first, with campaign, sender, platform, sentiment and reply count.", action: "create" });
  const listsOk = !audit.scopes.length || audit.scopes.includes("crm.lists.write");
  items.push(audit.qcSegment
    ? { id: "segment", kind: "segment", name: audit.qcSegment.id, label: `Segment: ${QC_VIEW_NAME}`, detail: "Already there, reused.", action: "reuse" }
    : { id: "segment", kind: "segment", name: QC_VIEW_NAME, label: `Segment: ${QC_VIEW_NAME}`, detail: listsOk ? "An active segment of every contact QC brings in, for reports, exports and workflows." : "Needs crm.lists.write on the key; skipped until it is ticked.", action: listsOk ? "create" : "skip" });
  if (!qcOwner && audit.scopes.length && !audit.scopes.includes("settings.users.write")) warnings.push("To add the QC Growth user, the key also needs settings.users.write. Tick it in HubSpot (Development → Keys) and re-read, or add a user named QC Growth in HubSpot yourself.");
  return {
    at: new Date().toISOString(),
    items,
    // The option's stored value: the client's own when they already had a QC Growth option, else ours.
    settings: { leadSourceProperty: leadSource?.name ?? null, leadSourceValue: leadSource ? leadSource.options.find((option) => /qc growth/i.test(option.label))?.value ?? "qc_growth" : null, lifecycleOnCreate: lifecycle, ownerId: qcOwner?.id ?? null },
    conversation: "Each conversation is logged as one note on the contact's timeline (LinkedIn or email, with campaign and sender), updated in place as the conversation continues.",
    notTouched: [
      "Existing fields, workflows, pipelines, segments and views (QC adds its own, never edits theirs)",
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
  // The QC Growth user, when the plan adds one: created, then found as an owner so contacts can be assigned.
  const ownerItem = plan.items.find((item) => item.kind === "owner" && item.action === "create");
  if (ownerItem) {
    try {
      await hubspot(token, "POST", "/settings/v3/users", { email: QC_OWNER_EMAIL, firstName: "QC", lastName: "Growth", sendWelcomeEmail: true }).catch((error) => {
        if (!(error instanceof HubSpotError && error.status === 409)) throw error;
      });
      const owner = list((await hubspot(token, "GET", `/crm/v3/owners?email=${encodeURIComponent(QC_OWNER_EMAIL)}&limit=1`)).results)[0];
      if (!owner) throw new Error("The user was added but HubSpot has not listed it as an owner yet; re-read in a minute.");
      plan.settings.ownerId = text(owner.id);
      log.push({ at: at(), kind: "owner", name: QC_OWNER_EMAIL, result: "created", detail: `QC Growth, owner ${text(owner.id)}` });
    } catch (error) {
      log.push({ at: at(), kind: "owner", name: QC_OWNER_EMAIL, result: "failed", detail: error instanceof Error ? error.message : "" });
    }
  }
  if (plan.items.some((item) => item.kind === "view" && item.action !== "skip")) {
    try {
      const existing = named(viewList(await hubspot(token, "GET", QC_VIEW_PATH).catch(() => [])), "id");
      const view = existing ?? { id: text((await hubspot(token, "POST", QC_VIEW_PATH, qcViewBody())).id), name: QC_VIEW_NAME };
      // An existing QC Growth view gets today's columns (new QC fields show up without rebuilding it).
      if (existing) await hubspot(token, "PUT", `${QC_VIEW_PATH}/${view.id}`, qcViewBody()).catch(() => hubspot(token, "PATCH", `${QC_VIEW_PATH}/${view.id}`, qcViewBody()));
      const back = await hubspot(token, "GET", `${QC_VIEW_PATH}/${view.id}`);
      const filtered = JSON.stringify(back.filterGroups ?? []).includes("qc_outreach_platform");
      const columns = list(back.columns).map((column) => text(column.name));
      const missing = QC_VIEW_COLUMNS.filter((name) => !columns.includes(name));
      log.push({ at: at(), kind: "view", name: QC_VIEW_NAME, result: !filtered || missing.length ? "failed" : existing ? "reused" : "created", detail: !filtered ? `View ${view.id} saved without its filter` : missing.length ? `View ${view.id} is missing columns: ${missing.join(", ")}` : `Contacts view ${view.id}, ${columns.length} columns` });
    } catch (error) {
      log.push({ at: at(), kind: "view", name: QC_VIEW_NAME, result: "failed", detail: error instanceof Error ? error.message : "" });
    }
  }
  if (plan.items.some((item) => item.kind === "segment" && item.action === "create")) {
    try {
      const existing = named(list((await hubspot(token, "POST", "/crm/v3/lists/search", { query: QC_VIEW_NAME, count: 50 })).lists), "listId");
      const id = existing?.id ?? text(object((await hubspot(token, "POST", "/crm/v3/lists", qcSegmentBody())).list).listId);
      log.push({ at: at(), kind: "segment", name: QC_VIEW_NAME, result: existing ? "reused" : "created", detail: `Segment ${id}` });
    } catch (error) {
      log.push({ at: at(), kind: "segment", name: QC_VIEW_NAME, result: "failed", detail: error instanceof Error ? error.message : "" });
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

const CONTACT_BASICS = ["email", "firstname", "lastname", "jobtitle", "company", "website", "city", "hubspot_owner_id"];

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
  put("qc_linkedin_url", record.linkedinCanonical);
  put("qc_company_linkedin_url", record.companyLinkedinUrl);
  put("qc_campaign", record.campaign);
  put("qc_sender", record.sender);
  put("qc_outreach_platform", record.platform === "Email Bison" ? "email_bison" : record.platform.toLowerCase());
  put("qc_first_reply_date", record.firstReplyAt ? new Date(record.firstReplyAt).toISOString() : "");
  put("qc_last_reply_date", record.lastReplyAt ? new Date(record.lastReplyAt).toISOString() : "");
  if (["positive", "neutral", "negative"].includes(record.sentiment)) put("qc_reply_sentiment", record.sentiment);
  put("qc_reply_count", record.replyCount);
  const basics: Row = { email: record.email, firstname: record.firstName, lastname: record.lastName, jobtitle: record.title, company: record.company, website: record.domain };

  // Find the contact: the one we stored, else by email, else by QC LinkedIn ID.
  let contactId = "";
  if (stored?.contact_id) {
    const found = await hubspot(token, "GET", `/crm/v3/objects/contacts/${encodeURIComponent(stored.contact_id)}?properties=${CONTACT_BASICS.join(",")}`).catch(() => null);
    if (found) contactId = text(found.id);
  }
  if (!contactId) {
    const filterGroups = [
      ...(record.email ? [{ filters: [{ propertyName: "email", operator: "EQ", value: record.email }] }] : []),
      ...(record.linkedinCanonical && usable.has("qc_linkedin_url") ? [{ filters: [{ propertyName: "qc_linkedin_url", operator: "EQ", value: record.linkedinCanonical }] }] : []),
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
    // A contact with no owner gets QC Growth; one the client already assigned keeps its owner.
    if (settings.ownerId && !text(current.hubspot_owner_id)) fill.hubspot_owner_id = settings.ownerId;
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
    const hit = list((await hubspot(token, "POST", "/crm/v3/objects/companies/search", { filterGroups: [{ filters: [{ propertyName: "domain", operator: "EQ", value: record.domain }] }], limit: 1, properties: ["domain", "name", "linkedin_company_page"] }).catch(() => ({} as Row))).results)[0];
    companyId = hit ? text(hit.id) : text((await hubspot(token, "POST", "/crm/v3/objects/companies", { properties: { domain: record.domain, ...(record.company ? { name: record.company } : {}), ...(record.companyLinkedinUrl ? { linkedin_company_page: record.companyLinkedinUrl } : {}) } }).catch(() => ({} as Row))).id) || null;
    // A company the client already had keeps its own values; only an empty LinkedIn page or name is filled.
    if (hit && companyId) {
      const current = object(hit.properties);
      const fill: Row = {};
      if (record.companyLinkedinUrl && !text(current.linkedin_company_page)) fill.linkedin_company_page = record.companyLinkedinUrl;
      if (record.company && !text(current.name)) fill.name = record.company;
      if (Object.keys(fill).length) await hubspot(token, "PATCH", `/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, { properties: fill }).catch(() => undefined);
    }
  }
  if (companyId) await hubspot(token, "PUT", `/crm/v4/objects/contact/${encodeURIComponent(contactId)}/associations/default/company/${encodeURIComponent(companyId)}`).catch(() => undefined);

  // The view's company columns live on the contact. Where QC has no domain or company LinkedIn for the lead,
  // they come from the company the contact is linked to in HubSpot (often the client's own record), empty only.
  if (!record.domain || !record.companyLinkedinUrl) {
    try {
      const contact = object((await hubspot(token, "GET", `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=associatedcompanyid,website,qc_company_linkedin_url`)).properties);
      const linked = companyId || text(contact.associatedcompanyid);
      if (linked && (!text(contact.website) || (usable.has("qc_company_linkedin_url") && !text(contact.qc_company_linkedin_url)))) {
        const company = object((await hubspot(token, "GET", `/crm/v3/objects/companies/${encodeURIComponent(linked)}?properties=domain,linkedin_company_page`)).properties);
        const fill: Row = {};
        if (!text(contact.website) && text(company.domain)) fill.website = text(company.domain);
        if (usable.has("qc_company_linkedin_url") && !text(contact.qc_company_linkedin_url) && text(company.linkedin_company_page)) fill.qc_company_linkedin_url = text(company.linkedin_company_page);
        if (Object.keys(fill).length) await hubspot(token, "PATCH", `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, { properties: fill });
      }
    } catch { /* the columns stay empty; the push itself already succeeded */ }
  }

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
