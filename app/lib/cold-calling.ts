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

import { campaigns as heyreachCampaigns, campaignById, leadsInListPage } from "./heyreach-api";
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
/** Whether a column exists — used to fail an enrich job loudly if the migration's generated columns are absent. */
async function columnExists(url: string, key: string, table: string, column: string): Promise<boolean> {
  const response = await fetch(`${url}/rest/v1/${table}?select=${column}&limit=1`, { headers: headers(key), cache: "no-store" }).catch(() => null);
  return Boolean(response && response.ok);
}

/** The HeyReach key + identity for a client, or null. */
async function workspaceFor(slug: string): Promise<{ id: string; name: string; slug: string; apiKey: string; brief: string } | null> {
  const { url, key } = config();
  if (!url || !key) return null;
  const w = (await rows(url, key, `rr_workspaces?select=id,name,slug,client_brief,heyreach_api_key_ciphertext&slug=eq.${encodeURIComponent(slug)}&limit=1`))[0];
  if (!w) return null;
  return { id: str(w.id), name: str(w.name), slug: str(w.slug), apiKey: str(w.heyreach_api_key_ciphertext), brief: str(w.client_brief) };
}

// ── Directory ──────────────────────────────────────────────────────────────────────────────────────

export type ColdCallClient = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; callable: number; withPhone: number };

/** Clients that have a HeyReach connection, with how many callable leads and how many have a phone. */
export async function listColdCallClients(): Promise<ColdCallClient[]> {
  const { url, key } = config();
  if (!url || !key) return [];
  const workspaces = (await rows(url, key, `rr_workspaces?select=id,name,slug,logo_url,accent_color,heyreach_api_key_ciphertext&order=name.asc`))
    .filter((w) => str(w.name).trim() && str(w.heyreach_api_key_ciphertext).trim());
  const out: ColdCallClient[] = [];
  for (const w of workspaces) {
    const id = str(w.id);
    const leads = await rows(url, key, `rr_leads?select=phone,conversation_count,raw_data&workspace_id=eq.${encodeURIComponent(id)}&limit=5000`);
    const callable = leads.filter((l) => isCallable(l));
    out.push({
      id, name: str(w.name), slug: str(w.slug), logoUrl: orNull(w.logo_url), accentColor: orNull(w.accent_color),
      callable: callable.length, withPhone: callable.filter((l) => orNull(l.phone)).length,
    });
  }
  return out;
}

/** A lead worth showing in a call list: has a phone, replied, or was pulled in for cold calling. */
function isCallable(lead: Row): boolean {
  const rr = obj(obj(lead.raw_data).reply_radar);
  return Boolean(orNull(lead.phone) || num(lead.conversation_count) > 0 || Object.keys(obj(rr.cold_call)).length > 0);
}

// ── The call list ──────────────────────────────────────────────────────────────────────────────────

export type CallLead = {
  id: string; name: string; title: string | null; company: string | null; linkedin: string | null;
  phone: string | null; icpScore: number | null; icpReason: string | null; replied: boolean;
  campaign: string | null; activity: string; lastCall: { caller: string | null; result: string | null; notes: string | null; at: string } | null; callCount: number;
};

function callLeadFromRow(lead: Row, logs: Row[]): CallLead {
  const rr = obj(obj(lead.raw_data).reply_radar);
  const enrichment = obj(rr.ai_ark);
  const cold = obj(rr.cold_call);
  const replied = num(lead.conversation_count) > 0;
  const campaign = orNull(obj(rr.campaign).name) || orNull(cold.campaignName);
  const mine = logs.filter((log) => str(log.lead_id) === str(lead.id));
  const last = mine[0];
  return {
    id: str(lead.id),
    name: str(lead.name) || "Unknown",
    title: orNull(lead.role) || orNull(enrichment.title) || orNull(enrichment.headline),
    company: orNull(lead.company),
    linkedin: orNull(lead.linkedin_profile_url),
    phone: orNull(lead.phone),
    icpScore: lead.icp_score === null || lead.icp_score === undefined ? null : num(lead.icp_score),
    icpReason: orNull(lead.icp_reason),
    replied,
    campaign,
    activity: replied ? "Replied" : Object.keys(cold).length ? "In campaign, no reply" : "No reply",
    lastCall: last ? { caller: orNull(last.caller), result: orNull(last.result), notes: orNull(last.notes), at: str(last.called_at) } : null,
    callCount: mine.length,
  };
}

/** A client's callable leads, sorted by ICP score (highest first), with call history attached. */
export async function getCallList(slug: string): Promise<{ ok: boolean; error?: string; client?: { name: string; slug: string }; leads?: CallLead[] }> {
  const { url, key } = config();
  if (!url || !key) return { ok: false, error: "Supabase is not configured." };
  const ws = await workspaceFor(slug);
  if (!ws) return { ok: false, error: `No client matches "${slug}".` };
  const leads = await rows(url, key, `rr_leads?select=id,name,role,company,linkedin_profile_url,phone,icp_score,icp_reason,conversation_count,raw_data&workspace_id=eq.${encodeURIComponent(ws.id)}&order=icp_score.desc.nullslast&limit=2000`);
  const logs = await rows(url, key, `rr_call_logs?select=lead_id,caller,result,notes,called_at&workspace_id=eq.${encodeURIComponent(ws.id)}&order=called_at.desc`);
  const callable = leads.filter(isCallable).map((lead) => callLeadFromRow(lead, logs));
  return { ok: true, client: { name: ws.name, slug: ws.slug }, leads: callable };
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
  const phone = profileUrl ? await findMobilePhone(profileUrl) : null;

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
      let enriched = num(job.leads_enriched);
      while (Date.now() < deadlineMs) {
        const batch = await rows(url, key, `rr_leads?select=id,name,company,linkedin_profile_url,icp_score,raw_data&workspace_id=eq.${encodeURIComponent(workspace.id)}&cold_campaign=eq.${encodeURIComponent(str(job.campaign_id))}&order=created_at.asc,id.asc&offset=${enriched}&limit=${ENRICH_BATCH}`);
        if (!batch.length) {
          if (enriched === 0) {
            const tagged = await rows(url, key, `rr_leads?select=id&workspace_id=eq.${encodeURIComponent(workspace.id)}&cold_campaign=eq.${encodeURIComponent(str(job.campaign_id))}&limit=1`);
            await patchJob({ status: "done", error: tagged.length ? `Enrich returned nothing at offset 0 though leads are tagged — ordering/offset problem.` : `No leads tagged for campaign ${str(job.campaign_id)}.` });
            return { processed: true, status: "done" };
          }
          await patchJob({ status: "done", error: null });
          return { processed: true, status: "done" };
        }
        // Surface the first real enrichment failure instead of finishing silently at 0.
        const outcomes = await Promise.all(batch.map((lead) => enrichColdLead(url, key, origin, workspace, lead).then(() => "").catch((e) => (e instanceof Error ? e.message : String(e)))));
        const firstErr = outcomes.find(Boolean);
        if (firstErr && enriched === 0) { await patchJob({ status: "error", error: `Enrichment failed: ${firstErr}`.slice(0, 400) }); return { processed: true, status: "error" }; }
        enriched += batch.length;
        await patchJob({ leads_enriched: enriched });
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
