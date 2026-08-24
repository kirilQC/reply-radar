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
  // The two batch reads are independent — run them together rather than one after the other.
  const [contacts, companies] = await Promise.all([
    hubspotBatchRead(token, "contacts", [...contactIds], ["email", "firstname", "lastname", "hs_linkedin_url", "jobtitle"]),
    hubspotBatchRead(token, "companies", [...companyIds], ["domain", "name"]),
  ]);

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

/** The array of typed value-objects Attio stores for one attribute. */
function attioValues(record: Record<string, unknown>, attribute: string): Array<Record<string, unknown>> {
  return ((record.values as Record<string, unknown> | undefined)?.[attribute] as Array<Record<string, unknown>> | undefined) ?? [];
}

/** The first primitive value of an Attio typed attribute. */
function attioValue(record: Record<string, unknown>, attribute: string): string {
  const first = attioValues(record, attribute)[0];
  if (!first) return "";
  return str(first.value ?? first.email_address ?? (first.status as Record<string, unknown> | undefined)?.title ?? first.full_name ?? first.option ?? "");
}

/**
 * A deal's monetary value.
 *
 * This is the parse that was silently returning nothing. Attio stores a currency attribute as
 * `{ currency_value, currency_code }`, not a plain `value`, so the old reader found no `.value` and
 * every amount came through blank — which is why every deal, "Attributed to QC" and "Total pipeline"
 * showed a dash. Reads both shapes now, and hands the currency code back alongside the number.
 */
function attioMoney(record: Record<string, unknown>, attribute: string): { amount: number | null; currency: string } {
  const first = attioValues(record, attribute)[0];
  if (!first) return { amount: null, currency: "" };
  const raw = first.currency_value ?? first.value;
  const amount = raw == null || str(raw) === "" ? null : Number(raw);
  return { amount: Number.isFinite(amount as number) ? (amount as number) : null, currency: str(first.currency_code) };
}

/** An actor-reference attribute's referenced id (deal owner is stored this way, not as text). */
function attioActorId(record: Record<string, unknown>, attribute: string): string {
  const first = attioValues(record, attribute)[0];
  if (!first) return "";
  return str(first.referenced_actor_id ?? first.actor_id ?? "");
}
function attioReferenceIds(record: Record<string, unknown>, attribute: string): string[] {
  const values = ((record.values as Record<string, unknown> | undefined)?.[attribute] as Array<Record<string, unknown>> | undefined) ?? [];
  return values
    .map((v) => str((v.target_record_id ?? v.record_id ?? (v.target_object as unknown)) as unknown))
    .filter(Boolean);
}

async function attioPeople(token: string, ids: string[]): Promise<Map<string, CrmContact>> {
  const map = new Map<string, CrmContact>();
  const unique = [...new Set(ids)];
  // A person per GET, but fetched a handful at a time rather than one-after-another — a client with hundreds
  // of deal contacts would otherwise be hundreds of serial round-trips. Capped so the sync does not hammer Attio.
  const CONCURRENCY = 6;
  for (let i = 0; i < unique.length; i += CONCURRENCY) {
    await Promise.all(unique.slice(i, i + CONCURRENCY).map(async (id) => {
      try {
        const body = await attio(token, `/v2/objects/people/records/${encodeURIComponent(id)}`, { method: "GET" });
        const record = (body.data as Record<string, unknown> | undefined) ?? {};
        map.set(id, { email: attioValue(record, "email_addresses"), linkedin: attioValue(record, "linkedin"), name: attioValue(record, "name") });
      } catch {
        // A person we cannot read just contributes no identifier; the deal is then unattributed, not broken.
      }
    }));
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
  const [people, members] = await Promise.all([attioPeople(token, [...peopleIds]), attioMembers(token)]);

  return records.map((record) => {
    const id = str(((record.id as Record<string, unknown> | undefined)?.record_id) ?? record.id);
    const stage = attioValue(record, "stage");
    const contacts = attioReferenceIds(record, "associated_people").map((pid) => people.get(pid)).filter((c): c is CrmContact => Boolean(c));
    const companyName = attioValue(record, "associated_company") || attioValue(record, "company");
    const money = attioMoney(record, "value");
    const ownerId = attioActorId(record, "owner");
    return {
      externalId: id,
      name: attioValue(record, "name"),
      amount: money.amount,
      currency: money.currency,
      stage,
      pipeline: "",
      status: statusFromStage(stage),
      closeDate: toIsoDate(attioValue(record, "close_date")),
      // Resolve the owner reference to a name; fall back to any inline text, else empty.
      owner: (ownerId && members.get(ownerId)) || attioValue(record, "owner"),
      contacts,
      companyName,
      companyDomain: attioValue(record, "domains") || attioValue(record, "domain"),
      raw: record,
    };
  });
}

/** Workspace member ids → names, so a deal's owner reference can be shown as a person. */
async function attioMembers(token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const body = await attio(token, "/v2/workspace_members", { method: "GET" });
    for (const member of (body.data as Array<Record<string, unknown>> | undefined) ?? []) {
      const mid = str(member.workspace_member_id ?? member.id);
      const name = [str(member.first_name), str(member.last_name)].filter(Boolean).join(" ") || str(member.email_address);
      if (mid) map.set(mid, name);
    }
  } catch {
    // No member list just means owners show as blank — the deal is intact, only a label is missing.
  }
  return map;
}

/* ── Pipeline discovery ─────────────────────────────────────────────────────────────────────────────
 *
 * No two clients organise their pipeline the same way. Bluevia runs Meeting Scheduled → In Conversation
 * → Champion Identified → Approver Engaged → Cleared to Pilot → Won → Dead; Willow runs Discovery →
 * Scoping → POV → Commercial → Won → Nurture → Lost. So the deals view cannot be built from a fixed set
 * of columns — it has to learn each client's own stages, in their own order, at sync time and build
 * from that. This reads that shape out of the CRM.
 */

export type PipelineStage = {
  /** The stage's own name, exactly as the client wrote it — this is the column heading. */
  title: string;
  /** "won" | "lost" | "open", inferred from the name, so the view can colour and total them. */
  kind: "won" | "lost" | "open";
  /** The client's colour for the stage where the CRM exposes one, for the column accent. */
  color: string | null;
};
export type Pipeline = { stages: PipelineStage[]; discoveredAt: string };

const stageKind = (title: string): "won" | "lost" | "open" => {
  const s = title.toLowerCase();
  if (/won|closed[\s_-]*won/.test(s)) return "won";
  if (/lost|closed[\s_-]*lost|dead|churn|disqualif/.test(s)) return "lost";
  return "open";
};

/**
 * Attio's ordered statuses for the deals `stage` attribute.
 *
 * Attempts the statuses endpoint; if the workspace names the stage attribute something else, or the
 * endpoint shape differs, it returns an empty list rather than throwing — the caller then falls back to
 * the stages seen on the deals themselves, so a discovery miss degrades to "unordered but complete"
 * rather than a broken sync.
 */
async function fetchAttioPipeline(token: string): Promise<Pipeline> {
  try {
    const body = await attio(token, "/v2/objects/deals/attributes/stage/statuses", { method: "GET" });
    const list = (body.data as Array<Record<string, unknown>> | undefined) ?? [];
    const stages = list
      .filter((row) => !row.is_archived)
      .map((row) => {
        const title = str(row.title);
        return { title, kind: stageKind(title), color: row.color ? str(row.color) : null };
      })
      .filter((stage) => stage.title);
    return { stages, discoveredAt: new Date().toISOString() };
  } catch {
    return { stages: [], discoveredAt: new Date().toISOString() };
  }
}

/**
 * HubSpot's ordered deal-pipeline stages.
 *
 * HubSpot can hold several pipelines; the default (or the first) is used, and its stages come already
 * ordered with a `displayOrder`. `metadata.isClosed` / `probability` tell won from lost more reliably
 * than the label does, so those are consulted first.
 */
async function fetchHubspotPipeline(token: string): Promise<Pipeline> {
  try {
    const body = await hubspot(token, "/crm/v3/pipelines/deals", { method: "GET" });
    const pipelines = (body.results as Array<Record<string, unknown>> | undefined) ?? [];
    const chosen = pipelines.find((p) => str(p.id) === "default") ?? pipelines[0];
    const raw = ((chosen?.stages as Array<Record<string, unknown>> | undefined) ?? [])
      .slice()
      .sort((a, b) => Number(a.displayOrder ?? 0) - Number(b.displayOrder ?? 0));
    const stages = raw.map((row) => {
      const title = str(row.label);
      const meta = (row.metadata as Record<string, unknown> | undefined) ?? {};
      const kind: "won" | "lost" | "open" =
        str(meta.isClosed) === "true"
          ? Number(meta.probability) >= 1 ? "won" : "lost"
          : stageKind(title);
      return { title, kind, color: null };
    }).filter((stage) => stage.title);
    return { stages, discoveredAt: new Date().toISOString() };
  } catch {
    return { stages: [], discoveredAt: new Date().toISOString() };
  }
}

/** Discover a client's pipeline shape — their own columns, in their own order. */
export async function fetchPipeline(provider: CrmProvider, token: string): Promise<Pipeline> {
  if (provider === "hubspot") return fetchHubspotPipeline(token);
  if (provider === "attio") return fetchAttioPipeline(token);
  return { stages: [], discoveredAt: new Date().toISOString() };
}

/** Pull all of a client's deals from their CRM. Throws with the provider's own message on a failure. */
export async function fetchDeals(provider: CrmProvider, token: string): Promise<CrmDeal[]> {
  if (!token) throw new Error("No CRM API key is saved for this client.");
  if (provider === "hubspot") return fetchHubspotDeals(token);
  if (provider === "attio") return fetchAttioDeals(token);
  throw new Error(`Unknown CRM provider "${provider}".`);
}
