// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Cold calling: call lists per client, and the pipeline that fills them.
 *
 * The people worth calling are the ones a campaign never got a reply from — and those are not in Reply Radar,
 * because the product ingests replies. So a client's cold-call list is built on demand, one campaign at a time:
 * pull every member of the campaign's HeyReach list (repliers and non-repliers alike), store each as a lead,
 * then enrich each with a profile, an ICP score and a mobile number. That last part is heavy and costs AI Ark
 * credits, so it is never automatic — a person clicks "Fetch & enrich" on a campaign and a background job
 * (advanced by the worker a batch at a time) works through it.
 *
 * The call list itself is just the client's leads that are callable — anyone with a phone, anyone who replied,
 * or anyone pulled in for cold calling — sorted by ICP score, each with their recent activity and call history.
 */

import { campaigns as heyreachCampaigns, campaignById, leadsInListPage, conversations as heyreachConversations } from "./heyreach-api";
import { enrichLeadWithAiArk, findMobilePhone } from "./ai-ark-enrichment";
import { isAiArkEnrichmentEnabled } from "./lead-identity";

type Row = Record<string, unknown>;

const str = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : String(value));
const orNull = (value: unknown) => (str(value).trim() ? str(value) : null);
const num = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const obj = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

function config() {
  return { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
}
function headers(key: string, write = false) {
  const h: Record<string, string> = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  if (write) h.Prefer = "return=representation";
  return h;
}
async function rows(url: string, key: string, path: string): Promise<Row[]> {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: headers(key), cache: "no-store" });
  if (!response.ok) return [];
  const body = await response.json().catch(() => []);
  return Array.isArray(body) ? (body as Row[]) : [];
}
/** A cheap exact row count via PostgREST's Content-Range header — no rows transferred. */
async function count(url: string, key: string, path: string): Promise<number> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { ...headers(key), Prefer: "count=exact", Range: "0-0", "Range-Unit": "items" }, cache: "no-store",
  }).catch(() => null);
  if (!response) return 0;
  const total = (response.headers.get("content-range") || "").split("/")[1];
  return total && total !== "*" ? Number(total) || 0 : 0;
}
/** Whether a column exists — used to fail an enrich job loudly if the migration's generated columns are absent. */
async function columnExists(url: string, key: string, table: string, column: string): Promise<boolean> {
  const response = await fetch(`${url}/rest/v1/${table}?select=${column}&limit=1`, { headers: headers(key), cache: "no-store" }).catch(() => null);
  return Boolean(response && response.ok);
}

/** The HeyReach key + identity for a client, or null. */
async function workspaceFor(slug: string): Promise<{ id: string; name: string; slug: string; apiKey: string; brief: string; logoUrl: string | null; accentColor: string | null } | null> {
  const { url, key } = config();
  if (!url || !key) return null;
  const w = (await rows(url, key, `rr_workspaces?select=id,name,slug,client_brief,logo_url,accent_color,heyreach_api_key_ciphertext&slug=eq.${encodeURIComponent(slug)}&limit=1`))[0];
  if (!w) return null;
  return { id: str(w.id), name: str(w.name), slug: str(w.slug), apiKey: str(w.heyreach_api_key_ciphertext), brief: str(w.client_brief), logoUrl: orNull(w.logo_url), accentColor: orNull(w.accent_color) };
}

// ── Directory ──────────────────────────────────────────────────────────────────────────────────────

export type ColdCallClient = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; callable: number; withPhone: number };

/** Clients that have a HeyReach connection, with how many callable leads and how many have a phone. */
export async function listColdCallClients(): Promise<ColdCallClient[]> {
  const { url, key } = config();
  if (!url || !key) return [];
  // Include clients with a HeyReach connection, plus the "Misc" workspace (a home for imported/custom lists,
  // which has no HeyReach key on purpose).
  const workspaces = (await rows(url, key, `rr_workspaces?select=id,name,slug,logo_url,accent_color,heyreach_api_key_ciphertext&order=name.asc`))
    .filter((w) => str(w.name).trim() && (str(w.heyreach_api_key_ciphertext).trim() || str(w.slug) === "misc"));
  // Count with cheap header-only queries — pulling every lead's raw_data across all clients times out.
  // "Callable" ≈ has a phone or was pulled in for cold calling (cold_campaign is set); both are real columns.
  const out = await Promise.all(workspaces.map(async (w) => {
    const id = str(w.id);
    const base = `rr_leads?workspace_id=eq.${encodeURIComponent(id)}`;
    const [callable, withPhone] = await Promise.all([
      count(url, key, `${base}&or=(phone.not.is.null,cold_campaign.not.is.null)`),
      count(url, key, `${base}&phone=not.is.null`),
    ]);
    return {
      id, name: str(w.name), slug: str(w.slug), logoUrl: orNull(w.logo_url), accentColor: orNull(w.accent_color),
      callable, withPhone,
    };
  }));
  return out;
}

/** A lead worth showing in a call list: has a phone, replied, or was pulled in for cold calling. */
function convoCount(rr: Row): number {
  // conversation_count is a generated column that isn't present on every DB, so read it from raw_data.
  return num(obj(rr.rollup).conversation_count);
}

function isCallable(lead: Row): boolean {
  const rr = obj(obj(lead.raw_data).reply_radar);
  return Boolean(orNull(lead.phone) || convoCount(rr) > 0 || Object.keys(obj(rr.cold_call)).length > 0);
}

// ── The call list ──────────────────────────────────────────────────────────────────────────────────

// What we can reliably tell from stored data: whether they replied. The connection-accept split
// ("didn't accept" vs "not contacted") isn't in our DB — it lives in HeyReach — so it's not modelled here.
export type CallStatus = "replied" | "no_reply";
export type CallLead = {
  id: string; name: string; title: string | null; company: string | null; linkedin: string | null;
  phone: string | null; photoUrl: string | null; companyLogoUrl: string | null;
  icpScore: number | null; icpReason: string | null; replied: boolean; status: CallStatus;
  campaign: string | null; campaigns: string[]; senders: string[]; lastReplyAt: string | null;
  activity: string; lastCall: { caller: string | null; result: string | null; notes: string | null; at: string } | null; callCount: number;
};

function callLeadFromRow(lead: Row, logs: Row[], replyAt: Map<string, string>): CallLead {
  const rr = obj(obj(lead.raw_data).reply_radar);
  const rollup = obj(rr.rollup);
  const enrichment = obj(rr.ai_ark);
  const cold = obj(rr.cold_call);
  const lastReplyAt = replyAt.get(str(lead.id)) ?? null;
  const replied = convoCount(rr) > 0 || Boolean(lastReplyAt);
  const campaign = orNull(obj(rr.campaign).name) || orNull(cold.campaignName);
  const campaigns = (Array.isArray(rollup.campaigns) ? rollup.campaigns.map(String) : []).filter(Boolean);
  if (!campaigns.length && campaign) campaigns.push(campaign);
  const senders = (Array.isArray(rollup.senders) ? rollup.senders.map(String) : []).filter(Boolean);
  const mine = logs.filter((log) => str(log.lead_id) === str(lead.id));
  const last = mine[0];
  return {
    id: str(lead.id),
    name: str(lead.name) || "Unknown",
    title: orNull(lead.role) || orNull(enrichment.title) || orNull(enrichment.headline),
    company: orNull(lead.company),
    linkedin: orNull(lead.linkedin_profile_url),
    phone: orNull(lead.phone),
    // The AI Ark enrichment persists both of these; fall back to null so the UI shows a monogram instead.
    photoUrl: orNull(enrichment.profilePhotoUrl),
    companyLogoUrl: orNull(enrichment.companyPhotoUrl),
    // Read the score straight from raw_data — the icp_score/icp_reason generated columns don't exist on
    // every database, and selecting a missing column 400s the whole query.
    icpScore: rr.icp_score === null || rr.icp_score === undefined ? null : num(rr.icp_score),
    icpReason: orNull(rr.icp_reason),
    replied,
    status: replied ? "replied" : "no_reply",
    campaign,
    campaigns,
    senders,
    lastReplyAt,
    activity: replied ? "Replied" : Object.keys(cold).length ? "In campaign, no reply" : "No reply",
    lastCall: last ? { caller: orNull(last.caller), result: orNull(last.result), notes: orNull(last.notes), at: str(last.called_at) } : null,
    callCount: mine.length,
  };
}

/** A client's callable leads, sorted by ICP score (highest first), with call history attached. */
const scriptKey = (workspaceId: string) => `cold_call_script:${workspaceId}`;

/** The per-client call script (typed in the cockpit, shared across the team). Stored in rr_app_config. */
export async function getCallScript(workspaceId: string): Promise<string> {
  const { url, key } = config();
  if (!url || !key) return "";
  const row = (await rows(url, key, `rr_app_config?select=value&key=eq.${encodeURIComponent(scriptKey(workspaceId))}&limit=1`))[0];
  return str(obj(row?.value).script);
}
export async function saveCallScript(slug: string, script: string): Promise<{ ok: boolean; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const ws = await workspaceFor(slug);
  if (!ws) return { ok: false, error: `No client matches "${slug}".` };
  const res = await fetch(`${url}/rest/v1/rr_app_config`, {
    method: "POST", headers: { ...headers(key), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key: scriptKey(ws.id), value: { script: String(script).slice(0, 20000) }, updated_at: new Date().toISOString() }),
  });
  return res.ok ? { ok: true } : { ok: false, error: "Could not save the script." };
}

/** Import a list of contacts + phone numbers from a CSV into this client's call list, under a named list. */
export async function importCsvLeads(slug: string, records: Array<Record<string, string>>, listName = ""): Promise<{ ok: boolean; imported: number; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, imported: 0, error: "Supabase is not configured." };
  const ws = await workspaceFor(slug);
  if (!ws) return { ok: false, imported: 0, error: `No client matches "${slug}".` };
  let imported = 0;
  const fetchedAt = new Date().toISOString();
  const listTitle = listName.trim() || "CSV import";
  const listId = `csv:${listTitle.toLowerCase().replace(/\s+/g, "-").slice(0, 60)}`;
  for (const r of records.slice(0, 2000)) {
    const name = str(r.name).trim();
    const phone = str(r.phone).replace(/[^\d+]/g, "").trim();
    if (!name && !phone) continue;
    const profileUrl = str(r.linkedin).trim();
    const cold = { campaignId: listId, campaignName: listTitle, fetchedAt, enriched: true, source: "csv" };
    const existing = profileUrl
      ? (await rows(url, key, `rr_leads?select=id,raw_data&workspace_id=eq.${encodeURIComponent(ws.id)}&linkedin_profile_url=eq.${encodeURIComponent(profileUrl)}&limit=1`))[0]
      : undefined;
    if (existing) {
      const existingRaw = obj(existing.raw_data);
      const rr = obj(existingRaw.reply_radar);
      const nextRr = { ...rr, cold_call: { ...obj(rr.cold_call), ...cold }, ...(phone ? { phone } : {}) };
      await fetch(`${url}/rest/v1/rr_leads?id=eq.${encodeURIComponent(str(existing.id))}`, { method: "PATCH", headers: headers(key), body: JSON.stringify({ raw_data: { ...existingRaw, reply_radar: nextRr } }) }).catch(() => {});
    } else {
      await fetch(`${url}/rest/v1/rr_leads`, {
        method: "POST", headers: headers(key),
        body: JSON.stringify({
          workspace_id: ws.id, linkedin_profile_url: profileUrl || null, name: name || null,
          role: str(r.title).trim() || null, company: str(r.company).trim() || null,
          raw_data: { reply_radar: { cold_call: cold, ...(phone ? { phone } : {}) } },
        }),
      }).catch(() => {});
    }
    imported++;
  }
  return { ok: true, imported };
}

/** Pull this lead's current LinkedIn conversation from HeyReach and upsert it into our tables. */
export async function refreshLeadConversation(slug: string, leadId: string): Promise<{ ok: boolean; error?: string; newMessages?: number }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const ws = await workspaceFor(slug);
  if (!ws) return { ok: false, error: `No client matches "${slug}".` };
  if (!ws.apiKey) return { ok: false, error: `${ws.name} has no HeyReach key connected.` };
  const lead = (await rows(url, key, `rr_leads?select=id,linkedin_profile_url&id=eq.${encodeURIComponent(leadId)}&limit=1`))[0];
  const profileUrl = str(lead?.linkedin_profile_url);
  if (!profileUrl) return { ok: false, error: "This lead has no LinkedIn profile URL to look up." };

  let convos;
  try { convos = (await heyreachConversations(ws.apiKey, { leadProfileUrl: profileUrl }, 10)).items; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : "HeyReach lookup failed." }; }

  let added = 0;
  for (const c of convos) {
    if (!c.id) continue;
    // Upsert the conversation on its natural key, returning our row id.
    const convRes = await fetch(`${url}/rest/v1/rr_conversations?on_conflict=workspace_id,heyreach_conversation_id`, {
      method: "POST", headers: { ...headers(key), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ workspace_id: ws.id, lead_id: leadId, heyreach_conversation_id: c.id, account_id: c.senderId || null, last_message_at: c.lastMessageAt || null, last_message_direction: c.lastMessageFrom === "lead" ? "inbound" : "outbound", last_refreshed_at: new Date().toISOString() }),
    }).catch(() => null);
    const convRow = convRes && convRes.ok ? ((await convRes.json().catch(() => []))[0] as Row) : null;
    const convId = str(convRow?.id);
    if (!convId) continue;
    // Dedupe against what we already have (no message id from this endpoint, so match on body+timestamp).
    const existing = await rows(url, key, `rr_messages?select=body,sent_at&conversation_id=eq.${encodeURIComponent(convId)}`);
    const seen = new Set(existing.map((m) => `${str(m.body).trim()}|${new Date(str(m.sent_at)).getTime()}`));
    const toInsert = c.messages
      .filter((m) => m.body && m.sentAt && !seen.has(`${str(m.body).trim()}|${new Date(str(m.sentAt)).getTime()}`))
      .map((m) => ({ conversation_id: convId, direction: m.from === "lead" ? "inbound" : "outbound", body: str(m.body), sent_at: m.sentAt }));
    if (toInsert.length) {
      const ins = await fetch(`${url}/rest/v1/rr_messages`, { method: "POST", headers: { ...headers(key), Prefer: "return=minimal" }, body: JSON.stringify(toInsert) }).catch(() => null);
      if (ins && ins.ok) added += toInsert.length;
    }
  }
  return { ok: true, newMessages: added };
}

export async function getCallList(slug: string): Promise<{ ok: boolean; error?: string; client?: { name: string; slug: string; logoUrl: string | null; accentColor: string | null; script: string }; leads?: CallLead[] }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const ws = await workspaceFor(slug);
  if (!ws) return { ok: false, error: `No client matches "${slug}".` };
  const leads = await rows(url, key, `rr_leads?select=id,name,role,company,linkedin_profile_url,phone,raw_data&workspace_id=eq.${encodeURIComponent(ws.id)}&limit=2000`);
  const logs = await rows(url, key, `rr_call_logs?select=lead_id,caller,result,notes,called_at&workspace_id=eq.${encodeURIComponent(ws.id)}&order=called_at.desc`);
  // Latest reply time per lead, for the "newest/oldest reply" sorts and the replied status.
  const convos = await rows(url, key, `rr_conversations?select=lead_id,last_message_at&workspace_id=eq.${encodeURIComponent(ws.id)}&order=last_message_at.desc`);
  const replyAt = new Map<string, string>();
  for (const c of convos) { const id = str(c.lead_id); const at = str(c.last_message_at); if (id && at && !replyAt.has(id)) replyAt.set(id, at); }
  // Sort by ICP score (highest first, unscored last) in code — the icp_score column isn't guaranteed to exist.
  const callable = leads.filter(isCallable).map((lead) => callLeadFromRow(lead, logs, replyAt))
    .sort((a, b) => (b.icpScore ?? -1) - (a.icpScore ?? -1));
  const script = await getCallScript(ws.id);
  return { ok: true, client: { name: ws.name, slug: ws.slug, logoUrl: ws.logoUrl, accentColor: ws.accentColor, script }, leads: callable };
}

// ── Campaigns + fetch jobs ───────────────────────────────────────────────────────────────────────

export type CampaignSummary = { id: string; name: string; status: string; listSize: number; fetched: number; enriched: number; job: { status: string; leadsFetched: number; leadsEnriched: number; total: number; error: string | null } | null };

/** Every campaign for a client, with how many of its leads we've already fetched/enriched and any live job. */
export async function listCampaigns(slug: string): Promise<{ ok: boolean; error?: string; client?: string; campaigns?: CampaignSummary[] }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const ws = await workspaceFor(slug);
  if (!ws) return { ok: false, error: `No client matches "${slug}".` };
  if (!ws.apiKey) return { ok: false, error: `${ws.name} has no HeyReach key connected.` };

  const [page, jobs, leads] = await Promise.all([
    heyreachCampaigns(ws.apiKey, 300).catch(() => ({ items: [], total: 0 })),
    rows(url, key, `rr_cold_call_jobs?select=campaign_id,status,leads_fetched,leads_enriched,total_leads,error&workspace_id=eq.${encodeURIComponent(ws.id)}&order=created_at.desc`),
    rows(url, key, `rr_leads?select=phone,cold_campaign,raw_data&workspace_id=eq.${encodeURIComponent(ws.id)}&cold_campaign=not.is.null&limit=8000`),
  ]);
  const fetchedByCampaign = new Map<string, { fetched: number; enriched: number }>();
  for (const lead of leads) {
    const cid = str(lead.cold_campaign);
    if (!cid) continue;
    const enrichedFlag = obj(obj(obj(lead.raw_data).reply_radar).cold_call).enriched === true;
    const entry = fetchedByCampaign.get(cid) ?? { fetched: 0, enriched: 0 };
    entry.fetched += 1;
    if (orNull(lead.phone) || enrichedFlag) entry.enriched += 1;
    fetchedByCampaign.set(cid, entry);
  }
  // Newest job per campaign (jobs come newest-first), so an errored or finished run still surfaces.
  const jobByCampaign = new Map<string, Row>();
  for (const j of jobs) { const cid = str(j.campaign_id); if (!jobByCampaign.has(cid)) jobByCampaign.set(cid, j); }
  const campaignsOut = page.items.map((c) => {
    const counts = fetchedByCampaign.get(c.id) ?? { fetched: 0, enriched: 0 };
    const job = jobByCampaign.get(c.id);
    return {
      id: c.id, name: c.name, status: c.status, listSize: c.listSize,
      fetched: counts.fetched, enriched: counts.enriched,
      job: job ? { status: str(job.status), leadsFetched: num(job.leads_fetched), leadsEnriched: num(job.leads_enriched), total: num(job.total_leads), error: orNull(job.error) } : null,
    };
  });
  return { ok: true, client: ws.name, campaigns: campaignsOut };
}

/** Queue a background fetch-&-enrich of one campaign. Idempotent: an active job for that campaign is reused. */
export async function startCampaignFetch(slug: string, campaignId: string, campaignName: string): Promise<{ ok: boolean; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const ws = await workspaceFor(slug);
  if (!ws) return { ok: false, error: `No client matches "${slug}".` };
  if (!campaignId) return { ok: false, error: "No campaign given." };
  const existing = await rows(url, key, `rr_cold_call_jobs?select=id&workspace_id=eq.${encodeURIComponent(ws.id)}&campaign_id=eq.${encodeURIComponent(campaignId)}&status=in.(queued,fetching,enriching)&limit=1`);
  if (existing.length) return { ok: true }; // already running
  const response = await fetch(`${url}/rest/v1/rr_cold_call_jobs`, {
    method: "POST", headers: headers(key), body: JSON.stringify({ workspace_id: ws.id, campaign_id: campaignId, campaign_name: campaignName || null, status: "queued" }),
  });
  return response.ok ? { ok: true } : { ok: false, error: "Could not start the fetch." };
}

// ── Call logging ─────────────────────────────────────────────────────────────────────────────────

export async function logCall(leadId: string, input: { caller?: string; result?: string; notes?: string }): Promise<{ ok: boolean; error?: string }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  if (!leadId) return { ok: false, error: "No lead given." };
  const lead = (await rows(url, key, `rr_leads?select=workspace_id&id=eq.${encodeURIComponent(leadId)}&limit=1`))[0];
  if (!lead) return { ok: false, error: "That lead no longer exists." };
  const response = await fetch(`${url}/rest/v1/rr_call_logs`, {
    method: "POST", headers: headers(key),
    body: JSON.stringify({ workspace_id: str(lead.workspace_id), lead_id: leadId, caller: orNull(input.caller), result: orNull(input.result), notes: orNull(input.notes) }),
  });
  return response.ok ? { ok: true } : { ok: false, error: "Could not log the call." };
}

// ── The background pipeline ──────────────────────────────────────────────────────────────────────

/** How many leads to enrich per pass before re-checking the clock. Each is up to three network calls. */
const ENRICH_BATCH = 4;

const nameOf = (raw: Row) => {
  const full = str(raw.full_name || raw.fullName).trim();
  if (full) return full;
  return [str(raw.first_name || raw.firstName), str(raw.last_name || raw.lastName)].map((p) => p.trim()).filter(Boolean).join(" ");
};
const companyOf = (raw: Row) => {
  const value = raw.company_name ?? raw.companyName ?? raw.company ?? raw.current_company ?? raw.currentCompany ?? raw.organization;
  return str(value && typeof value === "object" ? obj(value).name : value);
};
const roleOf = (raw: Row) => str(raw.position ?? raw.title ?? raw.job_title ?? raw.jobTitle ?? raw.headline ?? raw.occupation ?? raw.current_position);
const profileOf = (raw: Row) => str(raw.profile_url ?? raw.profileUrl ?? raw.linkedin_profile_url);

/** Store one campaign member as a lead (or tag an existing one with the campaign), preserving prior data. */
async function upsertColdLead(url: string, key: string, workspaceId: string, campaignId: string, campaignName: string, raw: Row): Promise<void> {
  const profileUrl = profileOf(raw);
  const cold = { campaignId, campaignName, fetchedAt: new Date().toISOString() };
  const existing = profileUrl
    ? (await rows(url, key, `rr_leads?select=id,raw_data&workspace_id=eq.${encodeURIComponent(workspaceId)}&linkedin_profile_url=eq.${encodeURIComponent(profileUrl)}&limit=1`))[0]
    : undefined;
  if (existing) {
    const existingRaw = obj(existing.raw_data);
    const rr = obj(existingRaw.reply_radar);
    // Only add the cold-call marker; never clobber an existing enrichment or score.
    const nextRaw = { ...existingRaw, reply_radar: { ...rr, cold_call: { ...obj(rr.cold_call), ...cold } } };
    await fetch(`${url}/rest/v1/rr_leads?id=eq.${encodeURIComponent(str(existing.id))}`, { method: "PATCH", headers: headers(key), body: JSON.stringify({ raw_data: nextRaw }) }).catch(() => {});
    return;
  }
  await fetch(`${url}/rest/v1/rr_leads`, {
    method: "POST", headers: headers(key),
    body: JSON.stringify({
      workspace_id: workspaceId,
      linkedin_profile_url: profileUrl || null,
      linkedin_id: orNull(raw.id ?? raw.linkedin_id ?? raw.linkedinId),
      name: nameOf(raw) || null,
      role: roleOf(raw) || null,
      company: companyOf(raw) || null,
      raw_data: { ...raw, reply_radar: { cold_call: cold } },
    }),
  }).catch(() => {});
}

/** Enrich one cold lead: profile (if missing), phone, then the ICP score, and mark it done. */
async function enrichColdLead(url: string, key: string, origin: string, workspace: { id: string; name: string }, lead: Row): Promise<void> {
  const leadId = str(lead.id);
  const profileUrl = str(lead.linkedin_profile_url);
  const raw = obj(lead.raw_data);
  const rr = obj(raw.reply_radar);

  let enrichment = obj(rr.ai_ark);
  if (Object.keys(enrichment).length === 0 && profileUrl && isAiArkEnrichmentEnabled()) {
    enrichment = (await enrichLeadWithAiArk({ url, key }, workspace.id, profileUrl, str(lead.company)).catch(() => null)) as Row ?? {};
  }
  // Credit-saver: if this lead already has a phone (found on any earlier enrichment, cold-calling or the
  // lead database button), keep it and DON'T call the phone finder again — that call costs AI Ark credits.
  const existingPhone = orNull(rr.phone);
  const phone = existingPhone ?? (profileUrl ? await findMobilePhone(profileUrl) : null);

  const nextRr: Row = { ...rr, cold_call: { ...obj(rr.cold_call), enriched: true } };
  if (Object.keys(enrichment).length > 0) { nextRr.ai_ark = enrichment; nextRr.enrichment_status = "enriched"; }
  if (phone) nextRr.phone = phone;
  // This write is the whole point — it marks the lead enriched and stores the phone. Surface its failure
  // (a bad generated-column cast, an oversized row, RLS) instead of swallowing it, so a broken write does not
  // read as "0 enriched" with no cause.
  const patchRes = await fetch(`${url}/rest/v1/rr_leads?id=eq.${encodeURIComponent(leadId)}`, { method: "PATCH", headers: headers(key), body: JSON.stringify({ raw_data: { ...raw, reply_radar: nextRr } }) }).catch(() => null);
  if (!patchRes || !patchRes.ok) {
    const detail = patchRes ? await patchRes.text().catch(() => "") : "network error";
    throw new Error(`lead write ${patchRes?.status ?? ""}: ${detail.slice(0, 180)}`);
  }

  // ICP score from the profile we just saved. The route is a machine path (open), scores from the lead's
  // enrichment, and caches — so it is safe to call once per lead.
  if (rr.icp_score === undefined || rr.icp_score === null) {
    await fetch(`${origin}/api/ai/icp-score`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ leadId, workspaceId: workspace.id, workspaceName: workspace.name, leadName: str(lead.name) }),
    }).catch(() => {});
  }
}

/**
 * Advance the oldest active cold-call job for as long as the deadline allows. Called each worker cycle via
 * /api/cold-calling/process; a job that does not finish in one pass is picked up again next cycle.
 */
export async function processColdCallJobs(origin: string, deadlineMs: number): Promise<{ processed: boolean; status?: string }> {
  const { url, key } = config();
  if (!url || !key) return { processed: false };
  const job = (await rows(url, key, `rr_cold_call_jobs?select=*&status=in.(queued,fetching,enriching)&order=created_at.asc&limit=1`))[0];
  if (!job) return { processed: false };
  const jobId = str(job.id);
  const patchJob = (fields: Row) => fetch(`${url}/rest/v1/rr_cold_call_jobs?id=eq.${encodeURIComponent(jobId)}`, { method: "PATCH", headers: headers(key), body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }) }).catch(() => {});

  const ws = (await rows(url, key, `rr_workspaces?select=id,name,heyreach_api_key_ciphertext&id=eq.${encodeURIComponent(str(job.workspace_id))}&limit=1`))[0];
  const apiKey = str(ws?.heyreach_api_key_ciphertext);
  const workspace = { id: str(job.workspace_id), name: str(ws?.name) };
  if (!apiKey) { await patchJob({ status: "error", error: "No HeyReach key for this client." }); return { processed: true, status: "error" }; }
  // The enrich phase filters on these generated columns; without them it would silently match nothing (0
  // enriched). Fail the job with an actionable message instead.
  if (!(await columnExists(url, key, "rr_leads", "cold_campaign"))) {
    await patchJob({ status: "error", error: "rr_leads is missing the cold_campaign / cold_enriched columns — run the two new ALTERs in the cold-calling migration, then click Fetch & enrich again." });
    return { processed: true, status: "error" };
  }

  try {
    let status = str(job.status);
    let listId = str(job.list_id);
    let total = num(job.total_leads);
    let offset = num(job.fetch_offset);
    let fetched = num(job.leads_fetched);

    // ── Fetch phase: pull the campaign's whole list, a page at a time, storing each as a lead. ──
    if (status === "queued" || status === "fetching") {
      if (!listId) {
        const campaign = await campaignById(apiKey, str(job.campaign_id));
        listId = campaign.listId;
        total = campaign.listSize;
        await patchJob({ status: "fetching", list_id: listId, total_leads: total });
        status = "fetching";
      }
      while (Date.now() < deadlineMs && listId) {
        const pageResult = await leadsInListPage(apiKey, listId, offset, 100);
        for (const raw of pageResult.items) await upsertColdLead(url, key, workspace.id, str(job.campaign_id), str(job.campaign_name), raw);
        fetched += pageResult.items.length;
        offset += pageResult.items.length;
        total = pageResult.total || total;
        await patchJob({ fetch_offset: offset, leads_fetched: fetched, total_leads: total });
        if (pageResult.items.length < 100 || offset >= total) { status = "enriching"; await patchJob({ status: "enriching" }); break; }
      }
    }

    // ── Enrich phase: profile + phone + ICP for every tagged lead, walked by POSITION. ──
    // Paging by offset (not by an "is this enriched" filter) is bulletproof: the tagged set is stable during
    // enrichment, so `offset = leads_enriched` is always the next lead to do, and a lead that yields no phone
    // is still counted so it is never retried. This sidesteps the generated boolean column entirely.
    if (status === "enriching") {
      // Walk the tagged leads by an id cursor (id is immutable, so paging stays stable across the writes we
      // make). Single-column order + `id=gt.` — no offset, no multi-column order (that combination came back
      // empty). Already-enriched leads are skipped in code, so a resume from the start costs no credits.
      let enriched = num(job.leads_enriched);
      let cursor = "";
      let scanned = 0;
      while (Date.now() < deadlineMs) {
        const after = cursor ? `&id=gt.${encodeURIComponent(cursor)}` : "";
        const batch = await rows(url, key, `rr_leads?select=id,name,company,linkedin_profile_url,raw_data&workspace_id=eq.${encodeURIComponent(workspace.id)}&cold_campaign=eq.${encodeURIComponent(str(job.campaign_id))}${after}&order=id.asc&limit=${ENRICH_BATCH}`);
        if (!batch.length) { await patchJob({ status: "done", error: null }); return { processed: true, status: "done" }; }
        cursor = str(batch[batch.length - 1].id);
        scanned += batch.length;
        // Skip leads already handled: marked enriched, or already carrying a phone from any prior enrichment.
        // Keeps AI Ark credit spend to genuinely new leads.
        const todo = batch.filter((lead) => {
          const leadRr = obj(obj(lead.raw_data).reply_radar);
          return obj(leadRr.cold_call).enriched !== true && !orNull(leadRr.phone);
        });
        if (todo.length) {
          const outcomes = await Promise.all(todo.map((lead) => enrichColdLead(url, key, origin, workspace, lead).then(() => "").catch((e) => (e instanceof Error ? e.message : String(e)))));
          const firstErr = outcomes.find(Boolean);
          if (firstErr && enriched === 0) { await patchJob({ status: "error", error: `Enrichment failed: ${firstErr}`.slice(0, 400) }); return { processed: true, status: "error" }; }
          enriched += todo.filter((_, i) => !outcomes[i]).length;
          await patchJob({ leads_enriched: enriched });
        }
        void scanned;
      }
    }
    return { processed: true, status };
  } catch (error) {
    await patchJob({ status: "error", error: (error instanceof Error ? error.message : "Cold-call job failed").slice(0, 400) });
    return { processed: true, status: "error" };
  }
}

// ── CSV export ───────────────────────────────────────────────────────────────────────────────────

const csvCell = (value: unknown) => {
  const s = str(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The client's call list as CSV — the readout the team exports after a blitz. */
export async function exportCallListCsv(slug: string): Promise<{ ok: boolean; error?: string; csv?: string; filename?: string }> {
  const list = await getCallList(slug);
  if (!list.ok) return { ok: false, error: list.error };
  const header = ["Name", "Title", "Company", "Phone", "LinkedIn", "ICP score", "Activity", "Last call result", "Last call by", "Last call notes", "Calls logged"];
  const lines = [header.map(csvCell).join(",")];
  for (const lead of list.leads ?? []) {
    lines.push([
      lead.name, lead.title ?? "", lead.company ?? "", lead.phone ?? "", lead.linkedin ?? "",
      lead.icpScore ?? "", lead.activity, lead.lastCall?.result ?? "", lead.lastCall?.caller ?? "", lead.lastCall?.notes ?? "", lead.callCount,
    ].map(csvCell).join(","));
  }
  return { ok: true, csv: lines.join("\n"), filename: `${slug}-cold-call-list.csv` };
}
