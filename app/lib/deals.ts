// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The I/O half of deals: connecting a client's CRM, pulling their pipeline, attributing each deal to QC (or
 * not), and reading it back for the directory and the client page. The certainty rules are the pure export of
 * `shared/deal-attribution.mjs`; the CRM fetching is `app/lib/crm.ts`; this stitches them to Supabase.
 *
 * QC's identity — who we can prove we put in front of the client — is gathered from two tables: the leads we
 * contacted (LinkedIn, the reliable id there) and the meetings that were booked (email and LinkedIn, the
 * stronger signal). A deal is only ever "confirmed" when a person on it matches one of those by a
 * person-unique id; a shared company is "possible" and left for a human.
 */

import { fetchDeals, fetchPipeline, type CrmProvider, type Pipeline } from "./crm";
import { campaignsForLead } from "./heyreach-api";
import { resolveWorkspace } from "./meetings";
import { buildQcIdentity, attributeDeal } from "../../shared/deal-attribution.mjs";

type Row = Record<string, unknown>;

export type Deal = {
  id: string;
  name: string | null;
  amount: number | null;
  currency: string | null;
  stage: string | null;
  status: string;
  closeDate: string | null;
  contactName: string | null;
  contactEmail: string | null;
  companyName: string | null;
  companyDomain: string | null;
  contactLinkedin: string | null;
  attribution: string;
  attributionReason: string | null;
  attributionMatchedBy: string | null;
  attributionCampaign: string | null;
  leadId: string | null;
  companyLogo: string | null;
  /** What the matcher computed, before any human override. */
  computedAttribution: string;
  /** True when a person reviewed this and marked it not-QC; the display attribution is then "none". */
  dismissed: boolean;
};

export type DealClient = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  accentColor: string | null;
  crmProvider: string | null;
  lastSyncedAt: string | null;
  total: number;
  confirmed: number;
  possible: number;
  confirmedValue: number;
  totalValue: number;
};

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const orNull = (value: unknown) => (str(value).trim() ? str(value) : null);

function config() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}
function authHeaders(key: string, write = false) {
  // content-type is always set — PostgREST ignores a PATCH/POST body without it. Harmless on a GET.
  const headers: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  if (write) headers.Prefer = "return=representation";
  return headers;
}
async function rows(url: string, key: string, path: string): Promise<Row[]> {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: authHeaders(key), cache: "no-store" });
  if (!response.ok) return [];
  const body = await response.json().catch(() => []);
  return Array.isArray(body) ? (body as Row[]) : [];
}

function dealFromRow(row: Row): Deal {
  return {
    id: str(row.id),
    name: orNull(row.name),
    amount: row.amount == null ? null : Number(row.amount),
    currency: orNull(row.currency),
    stage: orNull(row.stage),
    status: str(row.status) || "open",
    closeDate: orNull(row.close_date),
    contactName: orNull(row.contact_name),
    contactEmail: orNull(row.contact_email),
    companyName: orNull(row.company_name),
    companyDomain: orNull(row.company_domain),
    contactLinkedin: orNull(row.contact_linkedin),
    // A dismissed deal reads as "none" everywhere the display uses `attribution`, but the matcher's own
    // verdict is preserved in `computedAttribution` so the decision is reversible and never re-runs on
    // its own. The counts, the filters and the card colour all follow `attribution`.
    attribution: str(row.attribution_override) === "dismissed" ? "none" : (str(row.attribution) || "none"),
    computedAttribution: str(row.attribution) || "none",
    dismissed: str(row.attribution_override) === "dismissed",
    attributionReason: orNull(row.attribution_reason),
    attributionMatchedBy: orNull(row.attribution_matched_by),
    attributionCampaign: orNull(row.attribution_campaign),
    leadId: orNull(row.attribution_lead_id),
    companyLogo: orNull(row.company_logo),
  };
}

/** Save (or clear) a client's CRM connection. */
export async function connectCrm(slug: string, provider: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const client = await resolveWorkspace(slug);
  if (!client) return { ok: false, error: `No single client matches "${slug}".` };
  const chosen = provider.trim().toLowerCase();
  if (chosen && chosen !== "hubspot" && chosen !== "attio") return { ok: false, error: "Provider must be hubspot or attio." };
  const record: Row = { crm_provider: chosen || null };
  // Absent key means "leave the saved one"; an explicit empty provider clears the key too.
  if (apiKey.trim()) record.crm_api_key_ciphertext = apiKey.trim();
  if (!chosen) record.crm_api_key_ciphertext = null;
  const response = await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(client.id)}`, { method: "PATCH", headers: authHeaders(key), body: JSON.stringify(record) });
  return response.ok ? { ok: true } : { ok: false, error: "Could not save the CRM connection." };
}

/** A company website/domain out of a lead's enrichment blob, if the provider recorded one. Best-effort. */
function leadDomain(raw: unknown): string {
  const rr = ((raw as Record<string, unknown>)?.reply_radar ?? {}) as Record<string, unknown>;
  const enrichment = (rr.ai_ark ?? {}) as Record<string, unknown>;
  const company = (enrichment.company ?? {}) as Record<string, unknown>;
  const summary = (company.summary ?? {}) as Record<string, unknown>;
  return str(summary.website ?? summary.domain ?? company.website ?? company.domain ?? "");
}

/** A company logo out of a lead's enrichment, for the deal card. Best-effort. */
function leadLogo(raw: unknown): string {
  const rr = ((raw as Record<string, unknown>)?.reply_radar ?? {}) as Record<string, unknown>;
  const enrichment = (rr.ai_ark ?? {}) as Record<string, unknown>;
  return str(enrichment.companyPhotoSource ?? enrichment.companyPhotoUrl ?? "");
}

/**
 * Ask HeyReach, for a batch of LinkedIn profile URLs, which QC campaign (if any) each person is in.
 *
 * This is the authoritative source and the reason it runs first: HeyReach knows definitively whether QC
 * ever messaged a person, and its own URL matching is more forgiving than a string compare against our
 * mirror. A deal contact HeyReach recognises is a confirmed QC deal, full stop — even if that person
 * never landed in our leads table for this workspace.
 *
 * Bounded concurrency and a cap, because a large board could hold hundreds of contacts and HeyReach is
 * rate-limited. A lookup that errors just yields no campaign — the deal falls through to local matching.
 */
async function heyreachCampaignsFor(apiKey: string, profileUrls: string[]): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (!apiKey) return found;
  const unique = [...new Set(profileUrls.filter(Boolean))].slice(0, 500);
  const LANES = 4;
  for (let i = 0; i < unique.length; i += LANES) {
    await Promise.all(unique.slice(i, i + LANES).map(async (profileUrl) => {
      try {
        const page = await campaignsForLead(apiKey, { profileUrl }, 5);
        const campaign = page.items[0]?.name;
        if (campaign) found.set(profileUrl, campaign);
      } catch {
        // A single failed lookup is not fatal — that contact simply relies on local matching instead.
      }
    }));
  }
  return found;
}

/** The identifiers that prove QC contact, gathered from leads and meetings for one client. */
async function gatherQcIdentity(url: string, key: string, workspaceId: string) {
  const [leadRows, meetingRows] = await Promise.all([
    // `company` is the piece that was missing — the company QC contacted each lead at. `raw_data` carries
    // the enriched company, which sometimes holds a website we can turn into a domain for a stronger match.
    rows(url, key, `rr_leads?select=id,linkedin_profile_url,campaign_names,name,company,raw_data&workspace_id=eq.${encodeURIComponent(workspaceId)}&limit=20000`),
    rows(url, key, `rr_meetings?select=invitee_email,invitee_linkedin,campaign,company_domain,invitee_name,company_name&workspace_id=eq.${encodeURIComponent(workspaceId)}`),
  ]);
  return buildQcIdentity({
    leads: leadRows.map((r) => ({
      linkedin: str(r.linkedin_profile_url),
      campaign: str(r.campaign_names),
      name: str(r.name),
      company: str(r.company),
      domain: leadDomain(r.raw_data),
      leadId: str(r.id),
      companyLogo: leadLogo(r.raw_data),
    })),
    meetings: meetingRows.map((r) => ({ email: str(r.invitee_email), linkedin: str(r.invitee_linkedin), campaign: str(r.campaign), domain: str(r.company_domain), name: str(r.invitee_name), company: str(r.company_name), leadId: "", companyLogo: "" })),
  });
}

/**
 * Pull a client's deals from their CRM, attribute each, and upsert. Returns counts, or the CRM's own error so
 * the person can see whether it was a bad token or a missing scope. A re-sync updates rows in place.
 */
export async function syncDeals(slug: string): Promise<{ ok: boolean; error?: string; synced?: number; confirmed?: number; possible?: number }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const client = await resolveWorkspace(slug);
  if (!client) return { ok: false, error: `No single client matches "${slug}".` };
  const workspace = (await rows(url, key, `rr_workspaces?select=id,crm_provider,crm_api_key_ciphertext,heyreach_api_key_ciphertext&id=eq.${encodeURIComponent(client.id)}&limit=1`))[0];
  const provider = str(workspace?.crm_provider) as CrmProvider;
  const token = str(workspace?.crm_api_key_ciphertext);
  if (!provider || !token) return { ok: false, error: "Connect a CRM for this client first." };

  let deals;
  let pipeline: Pipeline;
  try {
    // The deals and the pipeline shape are fetched together: the sync should learn how *this* client
    // organises their board at the same moment it pulls what is on it.
    [deals, pipeline] = await Promise.all([fetchDeals(provider, token), fetchPipeline(provider, token)]);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The CRM could not be reached." };
  }

  // Discovery can come back empty if the CRM names its stage attribute unusually. Rather than store
  // nothing, fall back to the stages actually present on the deals — unordered, but complete, so the
  // view still has every column the client uses.
  if (pipeline.stages.length === 0) {
    const seen: string[] = [];
    for (const deal of deals) if (deal.stage && !seen.includes(deal.stage)) seen.push(deal.stage);
    pipeline = {
      stages: seen.map((title) => ({ title, kind: /won/i.test(title) ? "won" : /lost|dead/i.test(title) ? "lost" : "open", color: null })),
      discoveredAt: new Date().toISOString(),
    };
  }

  const qc = await gatherQcIdentity(url, key, client.id);

  // HeyReach first, as asked: the authoritative "did we ever message this person" for every LinkedIn URL
  // on the board. What it confirms overrides local matching, because it is the source our leads mirror.
  const heyreachKey = str(workspace?.heyreach_api_key_ciphertext);
  const contactUrls = deals.flatMap((d) => d.contacts.map((c) => c.linkedin).filter(Boolean));
  const heyreach = await heyreachCampaignsFor(heyreachKey, contactUrls);

  let confirmed = 0;
  let possible = 0;
  const records = deals.map((deal) => {
    // A HeyReach hit on any contact is a confirmed QC deal outright.
    const hit = deal.contacts.find((c) => c.linkedin && heyreach.has(c.linkedin));
    const verdict = hit
      ? {
          attribution: "confirmed" as const,
          matchedBy: "heyreach",
          campaign: heyreach.get(hit.linkedin) || "",
          reason: `${hit.name || "This contact"} was contacted in ${heyreach.get(hit.linkedin)} — confirmed by HeyReach.`,
          evidence: { linkedin: hit.linkedin, source: "heyreach" },
          leadId: "",
          companyLogo: "",
        }
      : attributeDeal({ contacts: deal.contacts, companyDomain: deal.companyDomain, companyName: deal.companyName }, qc);
    if (verdict.attribution === "confirmed") confirmed += 1;
    if (verdict.attribution === "possible") possible += 1;
    const primary = deal.contacts[0];
    return {
      workspace_id: client.id,
      provider,
      external_id: deal.externalId,
      name: deal.name || null,
      amount: deal.amount,
      currency: deal.currency || null,
      stage: deal.stage || null,
      pipeline: deal.pipeline || null,
      status: deal.status,
      close_date: deal.closeDate,
      owner: deal.owner || null,
      contact_name: primary?.name || null,
      contact_email: primary?.email || null,
      contact_linkedin: primary?.linkedin || null,
      company_name: deal.companyName || null,
      company_domain: deal.companyDomain || null,
      attribution: verdict.attribution,
      attribution_reason: verdict.reason || null,
      attribution_matched_by: verdict.matchedBy,
      attribution_campaign: verdict.campaign || null,
      attribution_evidence: verdict.evidence || {},
      attribution_lead_id: (verdict as { leadId?: string }).leadId || null,
      company_logo: deal.companyLogo || (verdict as { companyLogo?: string }).companyLogo || null,
      raw: deal.raw ?? {},
      synced_at: new Date().toISOString(),
    };
  });

  if (records.length) {
    for (let i = 0; i < records.length; i += 200) {
      const response = await fetch(`${url}/rest/v1/rr_deals?on_conflict=workspace_id,provider,external_id`, {
        method: "POST",
        headers: { ...authHeaders(key, true), Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify(records.slice(i, i + 200)),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        console.error("reply_radar_deals_upsert_failed", { client: client.slug, status: response.status, detail: detail.slice(0, 300) });
        return { ok: false, error: "Fetched the deals but could not save them." };
      }
    }
  }
  await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(client.id)}`, {
    method: "PATCH",
    headers: authHeaders(key),
    body: JSON.stringify({ crm_last_synced_at: new Date().toISOString(), crm_pipeline: pipeline }),
  }).catch(() => {});
  return { ok: true, synced: records.length, confirmed, possible };
}

/**
 * Sync every client that has a CRM connected — the nightly cron's job. Sequential and bounded by the
 * route's 300s budget; with a handful of connected CRMs that is ample, and if a very large account runs long
 * the next night simply catches up. Each client's failure is captured, never fatal to the rest.
 */
export async function syncAllConnectedDeals(): Promise<{ ok: boolean; results: Array<{ client: string; synced?: number; confirmed?: number; error?: string }> }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, results: [] };
  const workspaces = await rows(url, key, `rr_workspaces?select=slug,name&crm_provider=not.is.null`);
  const results: Array<{ client: string; synced?: number; confirmed?: number; error?: string }> = [];
  for (const w of workspaces) {
    const result = await syncDeals(str(w.slug));
    results.push({ client: str(w.name), synced: result.synced, confirmed: result.confirmed, error: result.error });
  }
  return { ok: true, results };
}

/** Every client with their deal totals and how much of the pipeline traces back to QC. */
export async function listDealClients(): Promise<DealClient[]> {
  const { url, key } = config();
  if (!url || !key) return [];
  const workspaces = (await rows(url, key, `rr_workspaces?select=id,name,slug,logo_url,accent_color,crm_provider,crm_last_synced_at&order=name.asc`)).filter((w) => str(w.name).trim());
  if (!workspaces.length) return [];
  const ids = workspaces.map((w) => str(w.id)).filter(Boolean);
  const dealRows = ids.length ? await rows(url, key, `rr_deals?select=workspace_id,amount,attribution&workspace_id=in.(${ids.map(encodeURIComponent).join(",")})`) : [];
  const byWorkspace = new Map<string, { total: number; confirmed: number; possible: number; confirmedValue: number; totalValue: number }>();
  for (const row of dealRows) {
    const wid = str(row.workspace_id);
    const entry = byWorkspace.get(wid) ?? { total: 0, confirmed: 0, possible: 0, confirmedValue: 0, totalValue: 0 };
    entry.total += 1;
    const amount = Number(row.amount) || 0;
    entry.totalValue += amount;
    if (str(row.attribution) === "confirmed") { entry.confirmed += 1; entry.confirmedValue += amount; }
    if (str(row.attribution) === "possible") entry.possible += 1;
    byWorkspace.set(wid, entry);
  }
  return workspaces
    .map((w) => {
      const id = str(w.id);
      const m = byWorkspace.get(id) ?? { total: 0, confirmed: 0, possible: 0, confirmedValue: 0, totalValue: 0 };
      return {
        id,
        name: str(w.name),
        slug: str(w.slug),
        logoUrl: orNull(w.logo_url),
        accentColor: orNull(w.accent_color),
        crmProvider: orNull(w.crm_provider),
        lastSyncedAt: orNull(w.crm_last_synced_at),
        ...m,
      };
    })
    .sort((a, b) => b.confirmedValue - a.confirmedValue || b.total - a.total || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * Record a human's review of one deal's attribution.
 *
 * "dismissed" means someone looked and decided the deal is not QC's; it overrides the matcher's verdict
 * for display, but the verdict itself is left in place so the decision can be undone and so a re-sync
 * never quietly overwrites it — the sync writes `attribution`, never `attribution_override`.
 */
export async function setDealOverride(dealId: string, override: "dismissed" | null): Promise<{ ok: boolean; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const response = await fetch(`${url}/rest/v1/rr_deals?id=eq.${encodeURIComponent(dealId)}`, {
    method: "PATCH",
    headers: authHeaders(key),
    body: JSON.stringify({ attribution_override: override, updated_at: new Date().toISOString() }),
  });
  return response.ok ? { ok: true } : { ok: false, error: "Could not save that review." };
}

/** One client, its CRM state, and its deals — confirmed first, then by close date. */
export async function getClientDeals(slug: string): Promise<{ client: { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null }; crm: { provider: string | null; connected: boolean; lastSyncedAt: string | null }; pipeline: Pipeline; deals: Deal[] } | null> {
  const { url, key } = config();
  if (!url || !key) return null;
  const w = (await rows(url, key, `rr_workspaces?select=id,name,slug,logo_url,accent_color,crm_provider,crm_api_key_ciphertext,crm_last_synced_at,crm_pipeline&slug=eq.${encodeURIComponent(slug)}&limit=1`))[0];
  if (!w) return null;
  const id = str(w.id);
  const dealRows = await rows(url, key, `rr_deals?select=*&workspace_id=eq.${encodeURIComponent(id)}&order=close_date.desc.nullslast`);
  // Confirmed at the top, then possible, then the rest — the whole point is to see QC's deals first.
  const rank = (a: string) => (a === "confirmed" ? 0 : a === "possible" ? 1 : 2);
  const deals = dealRows.map(dealFromRow).sort((a, b) => rank(a.attribution) - rank(b.attribution));
  const pipeline = (w.crm_pipeline && typeof w.crm_pipeline === "object" ? w.crm_pipeline : { stages: [], discoveredAt: null }) as Pipeline;
  return {
    client: { id, name: str(w.name), slug: str(w.slug), logoUrl: orNull(w.logo_url), accentColor: orNull(w.accent_color) },
    crm: { provider: orNull(w.crm_provider), connected: Boolean(str(w.crm_api_key_ciphertext)), lastSyncedAt: orNull(w.crm_last_synced_at) },
    pipeline,
    deals,
  };
}

/* ── One deal, in full — for the drawer ──────────────────────────────────────────────────────────
 *
 * When a deal was attributed to a lead, that lead is the whole story: who QC contacted, at what
 * company, in which campaign, and every message exchanged. This gathers it from the lead, the deal's
 * stored evidence, and the conversation the lead is joined to.
 */
export type DealDetail = {
  deal: Deal;
  lead: {
    name: string | null; role: string | null; company: string | null; linkedin: string | null;
    location: string | null; industry: string | null; headline: string | null; photoUrl: string | null;
    campaigns: string[]; icpScore: number | null;
  } | null;
  messages: { direction: string; body: string; sentAt: string | null }[];
};

export async function getDealDetail(dealId: string): Promise<DealDetail | null> {
  const { url, key } = config();
  if (!url || !key) return null;
  const dealRow = (await rows(url, key, `rr_deals?select=*&id=eq.${encodeURIComponent(dealId)}&limit=1`))[0];
  if (!dealRow) return null;
  const deal = dealFromRow(dealRow);

  // Prefer the lead the attribution matched. Fall back to finding a lead by the deal's contact LinkedIn.
  let leadRow = deal.leadId
    ? (await rows(url, key, `rr_leads?select=*&id=eq.${encodeURIComponent(deal.leadId)}&limit=1`))[0]
    : undefined;
  if (!leadRow && deal.contactLinkedin) {
    const handle = deal.contactLinkedin.match(/linkedin\.com\/in\/([^/?#\s]+)/i)?.[1];
    if (handle) leadRow = (await rows(url, key, `rr_leads?select=*&workspace_id=eq.${encodeURIComponent(str(dealRow.workspace_id))}&linkedin_profile_url=ilike.*${encodeURIComponent(handle)}*&limit=1`))[0];
  }

  let lead: DealDetail["lead"] = null;
  let messages: DealDetail["messages"] = [];
  if (leadRow) {
    const raw = (leadRow.raw_data ?? {}) as Record<string, unknown>;
    const radar = (raw.reply_radar ?? {}) as Record<string, unknown>;
    const enrichment = (radar.ai_ark ?? {}) as Record<string, unknown>;
    lead = {
      name: orNull(leadRow.name),
      role: orNull(leadRow.role) || (enrichment.title ? str(enrichment.title) : null),
      company: orNull(leadRow.company),
      linkedin: orNull(leadRow.linkedin_profile_url),
      location: enrichment.location ? str(enrichment.location) : null,
      industry: enrichment.industry ? str(enrichment.industry) : null,
      headline: enrichment.headline ? str(enrichment.headline) : null,
      photoUrl: enrichment.profilePhotoSource ? str(enrichment.profilePhotoSource) : null,
      campaigns: str(leadRow.campaign_names).split(";").map((c) => c.trim()).filter(Boolean),
      icpScore: leadRow.icp_score == null ? null : Number(leadRow.icp_score),
    };
    const conversations = await rows(url, key, `rr_conversations?select=id&lead_id=eq.${encodeURIComponent(str(leadRow.id))}`);
    const conversationIds = conversations.map((c) => str(c.id)).filter(Boolean);
    if (conversationIds.length) {
      const msgRows = await rows(url, key, `rr_messages?select=direction,body,sent_at&conversation_id=in.(${conversationIds.map(encodeURIComponent).join(",")})&order=sent_at.asc&limit=500`);
      messages = msgRows.map((m) => ({ direction: str(m.direction), body: str(m.body), sentAt: orNull(m.sent_at) }));
    }
  }
  return { deal, lead, messages };
}
