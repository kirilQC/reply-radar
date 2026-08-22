// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Pulling a client's deals out of their CRM, normalised to one shape the rest of Reply Radar can reason about.
 *
 * Two providers so far: HubSpot and Attio. Each returns the same `CrmDeal` — the fields we show, plus the one
 * thing attribution actually needs: the people on the deal, with their emails and LinkedIn URLs, because that
 * is what gets matched against who QC contacted. A provider call that fails throws with the CRM's own message
 * (a bad token, a missing scope), so the sync can show the person exactly what to fix rather than a blank list.
 *
 * HubSpot is the better-trodden of the two. Attio's API is typed-attribute-shaped and harder to pin down
 * without a live workspace, so its extraction is written defensively — a field it cannot read is left empty
 * rather than throwing — and is worth verifying against a real key before it is trusted for attribution.
 */

export type CrmContact = { email: string; linkedin: string; name: string };
export type CrmDeal = {
  externalId: string;
  name: string;
  amount: number | null;
  currency: string;
  stage: string;
  pipeline: string;
  status: "open" | "won" | "lost";
  closeDate: string | null;
  owner: string;
  contacts: CrmContact[];
  companyName: string;
  companyDomain: string;
  raw: unknown;
};

export type CrmProvider = "hubspot" | "attio";

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));

function statusFromStage(stage: string, won?: boolean): "open" | "won" | "lost" {
  if (won) return "won";
  const s = stage.toLowerCase();
  if (/won|closed[\s_-]*won/.test(s)) return "won";
  if (/lost|closed[\s_-]*lost|dead/.test(s)) return "lost";
  return "open";
}

function toIsoDate(value: unknown): string | null {
  const raw = str(value).trim();
  if (!raw) return null;
  const asNumber = Number(raw);
  const date = Number.isFinite(asNumber) && /^\d+$/.test(raw) ? new Date(asNumber) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

// ── HubSpot ────────────────────────────────────────────────────────────────────────────────────────

const HUBSPOT = "https://api.hubapi.com";

async function hubspot(token: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${HUBSPOT}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HubSpot ${response.status}: ${body.slice(0, 200) || "request failed"}`);
  }
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

async function hubspotBatchRead(token: string, object: string, ids: string[], properties: string[]): Promise<Map<string, Record<string, unknown>>> {
  const map = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < ids.length; i += 100) {
    const inputs = ids.slice(i, i + 100).map((id) => ({ id }));
    if (!inputs.length) continue;
    const body = await hubspot(token, `/crm/v3/objects/${object}/batch/read`, { method: "POST", body: JSON.stringify({ properties, inputs }) }).catch(() => ({}) as Record<string, unknown>);
    for (const record of (body.results as Array<Record<string, unknown>> | undefined) ?? []) map.set(str(record.id), record);
  }
  return map;
}

async function fetchHubspotDeals(token: string): Promise<CrmDeal[]> {
  const raw: Array<Record<string, unknown>> = [];
  let after = "";
  for (let page = 0; page < 50; page += 1) {
    const params = new URLSearchParams({
      limit: "100",
      properties: "dealname,amount,dealstage,pipeline,closedate,hs_is_closed_won,deal_currency_code",
      associations: "contacts,companies",
    });
    if (after) params.set("after", after);
    const body = await hubspot(token, `/crm/v3/objects/deals?${params.toString()}`, { method: "GET" });
    for (const deal of (body.results as Array<Record<string, unknown>> | undefined) ?? []) raw.push(deal);
    after = str(((body.paging as Record<string, unknown> | undefined)?.next as Record<string, unknown> | undefined)?.after);
    if (!after) break;
  }

  const assocIds = (deal: Record<string, unknown>, kind: string): string[] => {
    const results = (((deal.associations as Record<string, unknown> | undefined)?.[kind] as Record<string, unknown> | undefined)?.results as Array<Record<string, unknown>> | undefined) ?? [];
    return results.map((r) => str(r.id)).filter(Boolean);
  };
  const contactIds = new Set<string>();
  const companyIds = new Set<string>();
  for (const deal of raw) {
    assocIds(deal, "contacts").forEach((id) => contactIds.add(id));
    assocIds(deal, "companies").forEach((id) => companyIds.add(id));
  }
  const contacts = await hubspotBatchRead(token, "contacts", [...contactIds], ["email", "firstname", "lastname", "hs_linkedin_url", "jobtitle"]);
  const companies = await hubspotBatchRead(token, "companies", [...companyIds], ["domain", "name"]);

  return raw.map((deal) => {
    const props = (deal.properties as Record<string, unknown> | undefined) ?? {};
    const dealContacts: CrmContact[] = assocIds(deal, "contacts")
      .map((id) => contacts.get(id))
      .filter((c): c is Record<string, unknown> => Boolean(c))
      .map((c) => {
        const p = (c.properties as Record<string, unknown> | undefined) ?? {};
        return { email: str(p.email), linkedin: str(p.hs_linkedin_url), name: [str(p.firstname), str(p.lastname)].filter(Boolean).join(" ") };
      });
    const company = assocIds(deal, "companies").map((id) => companies.get(id)).find(Boolean);
    const companyProps = (company?.properties as Record<string, unknown> | undefined) ?? {};
    const stage = str(props.dealstage);
    return {
      externalId: str(deal.id),
      name: str(props.dealname),
      amount: props.amount != null && str(props.amount) !== "" ? Number(props.amount) : null,
      currency: str(props.deal_currency_code),
      stage,
      pipeline: str(props.pipeline),
      status: statusFromStage(stage, str(props.hs_is_closed_won) === "true"),
      closeDate: toIsoDate(props.closedate),
      owner: "",
      contacts: dealContacts,
      companyName: str(companyProps.name),
      companyDomain: str(companyProps.domain),
      raw: deal,
    };
  });
}

// ── Attio ──────────────────────────────────────────────────────────────────────────────────────────
// Written defensively against Attio's typed-attribute shape; verify against a live workspace before trusting.

const ATTIO = "https://api.attio.com";

async function attio(token: string, path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${ATTIO}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Attio ${response.status}: ${body.slice(0, 200) || "request failed"}`);
  }
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/** The first primitive value of an Attio typed attribute (its values are arrays of typed objects). */
function attioValue(record: Record<string, unknown>, attribute: string): string {
  const values = ((record.values as Record<string, unknown> | undefined)?.[attribute] as Array<Record<string, unknown>> | undefined) ?? [];
  const first = values[0];
  if (!first) return "";
  return str(first.value ?? first.email_address ?? (first.status as Record<string, unknown> | undefined)?.title ?? first.full_name ?? first.option ?? "");
}
function attioReferenceIds(record: Record<string, unknown>, attribute: string): string[] {
  const values = ((record.values as Record<string, unknown> | undefined)?.[attribute] as Array<Record<string, unknown>> | undefined) ?? [];
  return values
    .map((v) => str((v.target_record_id ?? v.record_id ?? (v.target_object as unknown)) as unknown))
    .filter(Boolean);
}

async function attioPeople(token: string, ids: string[]): Promise<Map<string, CrmContact>> {
  const map = new Map<string, CrmContact>();
  for (const id of [...new Set(ids)]) {
    try {
      const body = await attio(token, `/v2/objects/people/records/${encodeURIComponent(id)}`, { method: "GET" });
      const record = (body.data as Record<string, unknown> | undefined) ?? {};
      map.set(id, {
        email: attioValue(record, "email_addresses"),
        linkedin: attioValue(record, "linkedin"),
        name: attioValue(record, "name"),
      });
    } catch {
      // A person we cannot read just contributes no identifier; the deal is then unattributed, not broken.
    }
  }
  return map;
}

async function fetchAttioDeals(token: string): Promise<CrmDeal[]> {
  const records: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (let page = 0; page < 40; page += 1) {
    const body = await attio(token, `/v2/objects/deals/records/query`, { method: "POST", body: JSON.stringify({ limit: 500, offset }) });
    const batch = (body.data as Array<Record<string, unknown>> | undefined) ?? [];
    records.push(...batch);
    if (batch.length < 500) break;
    offset += batch.length;
  }

  const peopleIds = new Set<string>();
  for (const record of records) attioReferenceIds(record, "associated_people").forEach((id) => peopleIds.add(id));
  const people = await attioPeople(token, [...peopleIds]);

  return records.map((record) => {
    const id = str(((record.id as Record<string, unknown> | undefined)?.record_id) ?? record.id);
    const stage = attioValue(record, "stage");
    const contacts = attioReferenceIds(record, "associated_people").map((pid) => people.get(pid)).filter((c): c is CrmContact => Boolean(c));
    const companyName = attioValue(record, "associated_company") || attioValue(record, "company");
    return {
      externalId: id,
      name: attioValue(record, "name"),
      amount: attioValue(record, "value") ? Number(attioValue(record, "value")) : null,
      currency: "",
      stage,
      pipeline: "",
      status: statusFromStage(stage),
      closeDate: toIsoDate(attioValue(record, "close_date")),
      owner: attioValue(record, "owner"),
      contacts,
      companyName,
      companyDomain: attioValue(record, "domains") || attioValue(record, "domain"),
      raw: record,
    };
  });
}

/** Pull all of a client's deals from their CRM. Throws with the provider's own message on a failure. */
export async function fetchDeals(provider: CrmProvider, token: string): Promise<CrmDeal[]> {
  if (!token) throw new Error("No CRM API key is saved for this client.");
  if (provider === "hubspot") return fetchHubspotDeals(token);
  if (provider === "attio") return fetchAttioDeals(token);
  throw new Error(`Unknown CRM provider "${provider}".`);
}
