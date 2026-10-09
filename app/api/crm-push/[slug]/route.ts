// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { loadDestination, presentDestination, replyRecords, rows, saveDestination, withPushLock, type Destination } from "../../../lib/crm-push";
import { cleanMeeting, pushMeetingsPass } from "../../../lib/meetings-deals-run";
import { pushOne, pushPass } from "../../../lib/crm-push-run";
import { REQUIRED_SCOPES, hubspot as hubspotCall, hubspotApply, hubspotAudit, hubspotConnect, hubspotPlan, type HubSpotPlan } from "../../../lib/hubspot-push";
import { REPORTING_WAIT, hubspotBuildReporting, hubspotUserView } from "../../../lib/hubspot-reporting";
import { dealsApply, dealsAudit, dealsPlan, type DealsPlan } from "../../../lib/hubspot-deals";
import { attioDealsApply, attioDealsAudit, attioDealsPlan, type AttioDealsPlan } from "../../../lib/attio-deals";
import { ATTIO_REQUIRED_SCOPES, attioApply, attioAudit, attioConnect, attioPlan, type AttioPlan } from "../../../lib/attio-push";
import { hubspotAppConfigured, hubspotUserToken } from "../../../lib/hubspot-user";

/**
 * The onboarding cockpit's CRM panel for one client (session only). GET says where it stands; POST runs one
 * step: { action: "connect", provider, apiKey } | "replan" | "apply" (with optional settings) | "push"
 * ({ offset }) | "auto" ({ on }) | "disconnect". Writes to the client's CRM happen only on "apply" (the
 * approved plan) and "push"; connect and replan only read.
 */
export const maxDuration = 300;

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
}

async function workspaceOf(c: { url: string; key: string }, slug: string) {
  const [workspace] = await rows(c, `rr_workspaces?select=id,name,slug&slug=eq.${encodeURIComponent(slug)}&limit=1`);
  if (!workspace) throw new Error("Unknown client.");
  return { id: text(workspace.id), name: text(workspace.name) };
}

export async function GET(_: Request, context: { params: Promise<{ slug: string }> }) {
  try {
    const c = config();
    const workspace = await workspaceOf(c, (await context.params).slug);
    const destination = await loadDestination(c, workspace.id, "crm");
    return NextResponse.json({ ok: true, hubspotApp: hubspotAppConfigured(), crm: presentDestination(destination), pulse: await pulseOf(c, workspace.id, destination) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not read the CRM settings." }, { status: 500 });
  }
}

/**
 * The live pulse for the Operations page: contacts in the CRM now, how many of them QC brought in, and the
 * deals QC made from booked meetings. HubSpot counts are asked for live (a few seconds at most); Attio's "ours"
 * is QC's own push record.
 */
async function pulseOf(c: { url: string; key: string }, workspaceId: string, destination: Destination | null) {
  if (!destination?.api_key || destination.status !== "built") return null;
  const [lastReply, lastDeal] = await Promise.all([lastReplyAdded(c, workspaceId, destination).catch(() => null), lastDealAdded(c, workspaceId, destination).catch(() => null)]);
  const counts = await countsOf(c, workspaceId, destination);
  return counts ? { ...counts, lastReply, lastDeal } : null;
}

/** The newest person QC added to the CRM from a reply: name, company, when, and their record. */
async function lastReplyAdded(c: { url: string; key: string }, workspaceId: string, destination: Destination) {
  const enc = encodeURIComponent;
  const [record] = await rows(c, `rr_crm_push_records?select=conversation_id,contact_id,pushed_at&workspace_id=eq.${enc(workspaceId)}&provider=eq.${enc(destination.provider)}&created_contact=is.true&error=is.null&order=pushed_at.desc&limit=1`);
  if (!record) return null;
  const [conversation] = await rows(c, `rr_conversations?select=lead_id&id=eq.${enc(text(record.conversation_id))}&limit=1`);
  const { records } = conversation?.lead_id ? await replyRecords(c, workspaceId, { leadIds: [text(conversation.lead_id)], limit: 5 }) : { records: [] as Array<{ name: string; company: string }> };
  const person = records[0];
  return { name: person?.name ?? "", company: person?.company ?? "", at: text(record.pushed_at), link: recordLink(destination, "person", text(record.contact_id)) };
}

/** The newest booked meeting QC turned into a deal: who, which company, when it was booked for, and the deal. */
async function lastDealAdded(c: { url: string; key: string }, workspaceId: string, destination: Destination) {
  const enc = encodeURIComponent;
  const [deal] = await rows(c, `rr_crm_push_meetings?select=meeting_id,deal_id,pushed_at&workspace_id=eq.${enc(workspaceId)}&provider=eq.${enc(destination.provider)}&deal_id=not.is.null&error=is.null&order=pushed_at.desc&limit=1`);
  if (!deal) return null;
  const [meeting] = await rows(c, `rr_meetings?select=invitee_name,company_name,meeting_at,when_text&id=eq.${enc(text(deal.meeting_id))}&limit=1`);
  const clean = meeting ? cleanMeeting(meeting) : null;
  return { name: text(clean?.invitee_name), company: text(clean?.company_name), meetingAt: text(meeting?.meeting_at) || text(meeting?.when_text), at: text(deal.pushed_at), link: recordLink(destination, "deal", text(deal.deal_id)) };
}

function recordLink(destination: Destination, kind: "person" | "deal", id: string): string | null {
  if (!id) return null;
  if (destination.provider === "hubspot") {
    const host = (destination.account_name ?? "").includes("hubspot.com") ? destination.account_name : "app.hubspot.com";
    return destination.account_id ? `https://${host}/contacts/${destination.account_id}/record/${kind === "deal" ? "0-3" : "0-1"}/${id}` : null;
  }
  const slug = text(((destination.config ?? {}) as Row).attio_slug);
  return slug ? `https://app.attio.com/${slug}/${kind === "deal" ? "deals" : "person"}/${id}/overview` : null;
}

async function countsOf(c: { url: string; key: string }, workspaceId: string, destination: Destination) {
  if (!destination.api_key) return null;
  const within = <T,>(work: Promise<T>, fallback: T) => Promise.race([work.catch(() => fallback), new Promise<T>((done) => setTimeout(() => done(fallback), 5000))]);
  const enc = encodeURIComponent;
  const deals = within(rows(c, `rr_crm_push_meetings?select=deal_id&workspace_id=eq.${enc(workspaceId)}&provider=eq.${enc(destination.provider)}&deal_id=not.is.null&limit=5000`).then((list) => new Set(list.map((row) => String(row.deal_id))).size as number | null), null);
  if (destination.provider === "hubspot") {
    const key = destination.api_key;
    const count = (filters: Row[]) => hubspotCall(key, "POST", "/crm/v3/objects/contacts/search", { limit: 1, properties: ["hs_object_id"], ...(filters.length ? { filterGroups: [{ filters }] } : {}) }).then((data) => Number(data.total) || 0);
    const [total, ours, dealCount] = await Promise.all([
      within(count([]) as Promise<number | null>, null),
      within(count([{ propertyName: "qc_outreach_platform", operator: "HAS_PROPERTY" }]) as Promise<number | null>, null),
      deals,
    ]);
    return { at: new Date().toISOString(), totalContacts: total, ourContacts: ours, deals: dealCount };
  }
  const [ours, dealCount] = await Promise.all([
    within(rows(c, `rr_crm_push_records?select=error&workspace_id=eq.${enc(workspaceId)}&provider=eq.attio&error=is.null&limit=50000`).then((list) => list.length as number | null), null),
    deals,
  ]);
  return { at: new Date().toISOString(), totalContacts: null, ourContacts: ours, deals: dealCount };
}

export async function POST(request: Request, context: { params: Promise<{ slug: string }> }) {
  const body = (await request.json().catch(() => ({}))) as Row;
  const action = text(body.action);
  try {
    const c = config();
    const workspace = await workspaceOf(c, (await context.params).slug);
    let destination = await loadDestination(c, workspace.id, "crm");
    const reply = async (extra: Row = {}) => NextResponse.json({ ok: true, ...extra, hubspotApp: hubspotAppConfigured(), crm: presentDestination(await loadDestination(c, workspace.id, "crm")) });

    if (action === "connect") {
      const provider = text(body.provider);
      const apiKey = text(body.apiKey);
      if (provider === "attio") {
        if (!apiKey) return NextResponse.json({ ok: false, error: "Paste the client's Attio API key." }, { status: 400 });
        const account = await attioConnect(apiKey);
        const clash = await rows(c, `rr_crm_push?select=workspace_id&provider=eq.attio&account_id=eq.${encodeURIComponent(account.workspaceId)}&workspace_id=neq.${encodeURIComponent(workspace.id)}&limit=1`);
        if (clash.length) return NextResponse.json({ ok: false, error: `Attio workspace ${account.name} is already connected to another client. Check you are in ${workspace.name}'s Attio.` }, { status: 409 });
        const audit = await attioAudit(apiKey, account.scopes);
        const plan = { ...attioPlan(audit), deals: attioDealsPlan(await attioDealsAudit(apiKey)) };
        await saveDestination(c, workspace.id, "crm", { provider: "attio", api_key: apiKey, account_id: account.workspaceId, account_name: account.name, status: "planned", audit: audit as unknown as Row, plan: plan as unknown as Row, build_log: [], auto_push: false, config: { attio_slug: account.slug } });
        return reply();
      }
      if (provider !== "hubspot") return NextResponse.json({ ok: false, error: "Choose HubSpot or Attio." }, { status: 400 });
      if (!apiKey) return NextResponse.json({ ok: false, error: "Paste the client's HubSpot service key." }, { status: 400 });
      const account = await hubspotConnect(apiKey);
      // One portal, one client: a key for a portal already linked to another client is refused.
      const clash = await rows(c, `rr_crm_push?select=workspace_id&provider=eq.hubspot&account_id=eq.${encodeURIComponent(account.portalId)}&workspace_id=neq.${encodeURIComponent(workspace.id)}&limit=1`);
      if (clash.length) return NextResponse.json({ ok: false, error: `HubSpot portal ${account.portalId} is already connected to another client. Check you are in ${workspace.name}'s HubSpot.` }, { status: 409 });
      const audit = await hubspotAudit(apiKey, account.scopes);
      const plan = { ...hubspotPlan(audit), deals: dealsPlan(await dealsAudit(apiKey)) };
      await saveDestination(c, workspace.id, "crm", { provider: "hubspot", api_key: apiKey, account_id: account.portalId, account_name: account.name, status: "planned", audit: audit as unknown as Row, plan: plan as unknown as Row, build_log: [], auto_push: false });
      return reply();
    }
    if (!destination?.api_key) return NextResponse.json({ ok: false, error: "Connect the CRM first." }, { status: 400 });

    if (action === "replan" && destination.provider === "attio") {
      const account = await attioConnect(destination.api_key);
      const audit = await attioAudit(destination.api_key, account.scopes);
      const previousDeals = ((destination.plan ?? {}) as { deals?: AttioDealsPlan }).deals ?? null;
      const plan = { ...attioPlan(audit), deals: attioDealsPlan(await attioDealsAudit(destination.api_key), previousDeals) };
      await saveDestination(c, workspace.id, "crm", { audit: audit as unknown as Row, plan: plan as unknown as Row, status: destination.status === "built" ? "built" : "planned" });
      return reply();
    }
    // Nothing is built on a key that is short a scope: the scopes are asked for live from HubSpot or Attio
    // right before every build, and the build stops and names each missing one. Half a build never happens.
    const gated = destination;
    const scopeGate = async (): Promise<NextResponse | null> => {
      const destination = gated;
      const key = destination.api_key!;
      const scopes = destination.provider === "attio" ? (await attioConnect(key)).scopes : (await hubspotConnect(key)).scopes;
      const missing = destination.provider === "attio"
        ? ATTIO_REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope) && !(scope.endsWith(":read") && scopes.includes(`${scope}-write`)))
        : REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
      const where = destination.provider === "attio" ? "Attio (Workspace settings → Developers → the QC Growth token)" : "HubSpot (Development → Keys → the QC Growth key)";
      if (!scopes.length) return NextResponse.json({ ok: false, error: `Could not read the key's scopes from ${destination.provider === "attio" ? "Attio" : "HubSpot"}, so nothing was built. Re-read and try again.` }, { status: 400 });
      if (!missing.length) return null;
      await saveDestination(c, workspace.id, "crm", { audit: { ...((destination.audit ?? {}) as Row), scopes, missingScopes: missing } as unknown as Row });
      return NextResponse.json({ ok: false, missingScopes: missing, error: `Nothing was built. The key is missing ${missing.length === 1 ? "this scope" : `these ${missing.length} scopes`}: ${missing.join(", ")}. Add ${missing.length === 1 ? "it" : "them"} in ${where}, then click Re-read and build again.` }, { status: 400 });
    };

    if (action === "apply" && destination.provider === "attio") {
      const blocked = await scopeGate();
      if (blocked) return blocked;
      const plan = destination.plan as unknown as AttioPlan;
      const choices = (body.settings && typeof body.settings === "object" ? body.settings : {}) as Row;
      const approved: AttioPlan & { deals?: AttioDealsPlan } = { ...plan, settings: { ...plan.settings, ...(text(choices.ownerId) ? { ownerId: text(choices.ownerId) } : {}) } };
      // The Booked Meeting (QC) status is part of every build, never skipped.
      const planDeals = attioDealsPlan(await attioDealsAudit(destination.api_key), (plan as AttioPlan & { deals?: AttioDealsPlan }).deals);
      if (!planDeals.available) return NextResponse.json({ ok: false, error: "Booked Meeting (QC) stage: the Deals object is switched off in this Attio workspace (or the token can't see it). Turn on Deals in Attio (Workspace settings → Objects), then re-read." }, { status: 400 });
      const log = await attioApply(destination.api_key, approved);
      {
        const deals: AttioDealsPlan = { ...planDeals, enabled: true };
        log.push(...(await attioDealsApply(destination.api_key, deals)));
        approved.deals = { ...deals, statusExists: deals.enabled ? true : deals.statusExists, createAttributes: deals.enabled ? [] : deals.createAttributes };
      }
      const failed = log.filter((entry) => entry.result === "failed");
      // A client already built stays built when a rebuild hits a snag (the log shows it): pushes keep running.
      // The stage's position is reported, not blocking: the stage itself exists and deals land in it.
      const blocking = failed.filter((entry) => entry.kind !== "deal-stage-order");
      await saveDestination(c, workspace.id, "crm", { plan: approved as unknown as Row, build_log: [...(destination.build_log ?? []), ...log] as unknown as Row[], status: blocking.length && destination.status !== "built" ? "planned" : "built", ...(!blocking.length && destination.status !== "built" ? { auto_push: true } : {}) });
      return reply({ built: !failed.length, failed: failed.map((entry) => `${entry.name}: ${entry.detail}`) });
    }
    if (action === "replan") {
      // The key's scopes are asked for again: ticking a scope in HubSpot must clear the warning on re-read.
      const account = await hubspotConnect(destination.api_key);
      const audit = await hubspotAudit(destination.api_key, account.scopes);
      const previousDeals = ((destination.plan ?? {}) as { deals?: DealsPlan }).deals ?? null;
      const plan = { ...hubspotPlan(audit), deals: dealsPlan(await dealsAudit(destination.api_key), previousDeals) };
      await saveDestination(c, workspace.id, "crm", { audit: audit as unknown as Row, plan: plan as unknown as Row, status: destination.status === "built" ? "built" : "planned" });
      return reply();
    }
    if (action === "apply") {
      const blocked = await scopeGate();
      if (blocked) return blocked;
      const plan = destination.plan as unknown as HubSpotPlan;
      // The person's choices on the plan: owner for new contacts, lifecycle on create, the lead source option.
      const choices = (body.settings && typeof body.settings === "object" ? body.settings : {}) as Row;
      const settings = {
        ...plan.settings,
        // QC Growth owns QC's leads; an empty choice keeps the plan's QC Growth owner rather than unassigning.
        ...(text(choices.ownerId) ? { ownerId: text(choices.ownerId) } : {}),
        ...(choices.lifecycleOnCreate !== undefined ? { lifecycleOnCreate: choices.lifecycleOnCreate ? "lead" : null } : {}),
      };
      const items = choices.useLeadSource === false ? plan.items.map((item) => (item.kind === "option" ? { ...item, action: "skip" as const } : item)) : plan.items;
      const approved: HubSpotPlan & { deals?: DealsPlan } = { ...plan, items, settings: choices.useLeadSource === false ? { ...settings, leadSourceProperty: null, leadSourceValue: null } : settings };
      const log = await hubspotApply(destination.api_key, approved);
      // Booked meetings as deals: the chosen pipeline (re-planned when it changed), its QC stage, the deal fields.
      // The Booked Meeting (QC) stage is part of every build, never skipped: re-read now, and refuse the build
      // while HubSpot won't let the key see deals.
      const planDeals = (plan as HubSpotPlan & { deals?: DealsPlan }).deals;
      const freshDeals = dealsPlan(await dealsAudit(destination.api_key), { ...(planDeals ?? {}), pipelineId: text(choices.dealPipelineId) || planDeals?.pipelineId || null });
      if (freshDeals.blocker) return NextResponse.json({ ok: false, error: `Booked Meeting (QC) stage: ${freshDeals.blocker}` }, { status: 400 });
      {
        const deals: DealsPlan = { ...freshDeals, enabled: true };
        const built = await dealsApply(destination.api_key, deals);
        log.push(...(built.log as typeof log));
        approved.deals = { ...deals, stageId: built.stageId, stageExists: Boolean(built.stageId) };
      }
      // Reports and the dashboard need the QC Growth user's sign-in (a service key acts as nobody).
      const userToken = await hubspotUserToken(c, destination).catch(() => null);
      if (userToken) {
        const reporting = await hubspotBuildReporting(userToken);
        log.push(...reporting.log);
        const userView = destination.config?.view_user_id ? null : await hubspotUserView(userToken, (destination.audit as { qcView?: { id: string } } | null)?.qcView?.id ?? null);
        if (userView) log.push(userView.log);
        await saveDestination(c, workspace.id, "crm", { config: { ...(destination.config ?? {}), ...(reporting.dashboardId ? { dashboard_id: reporting.dashboardId } : {}), ...(userView?.viewId ? { view_user_id: userView.viewId } : {}) } });
        destination = await loadDestination(c, workspace.id, "crm") ?? destination;
      }
      const failed = log.filter((entry) => entry.result === "failed");
      // A client already built stays built when a rebuild hits a snag (the log shows it): pushes keep running.
      // The stage's position is reported, not blocking: the stage itself exists and deals land in it.
      const blocking = failed.filter((entry) => entry.kind !== "deal-stage-order");
      await saveDestination(c, workspace.id, "crm", { plan: approved as unknown as Row, build_log: [...(destination.build_log ?? []), ...log] as unknown as Row[], status: blocking.length && destination.status !== "built" ? "planned" : "built", ...(!blocking.length && destination.status !== "built" ? { auto_push: true } : {}) });
      return reply({ built: !failed.length, failed: failed.map((entry) => `${entry.name}: ${entry.detail}`) });
    }
    if (action === "push_one") {
      const test = await withPushLock(c, workspace.id, "crm", 300_000, () => pushOne(c, destination as Destination));
      if (test === null) return NextResponse.json({ ok: false, error: "A push is already running for this client. Try again in a minute." }, { status: 409 });
      return reply({ test });
    }
    if (action === "push") {
      const offset = Number(body.offset) || 0;
      const done = await withPushLock(c, workspace.id, "crm", 300_000, async () => {
        const summary = await pushPass(c, destination as Destination, { offset, budgetMs: 150_000 });
        // Booked meetings ride along with the first pass of a Push all.
        const meetings = offset === 0 ? await pushMeetingsPass(c, destination as Destination, { budgetMs: 60_000 }).catch((error) => ({ pushed: 0, created: 0, updated: 0, unchanged: 0, failed: 1, errors: [error instanceof Error ? error.message : "failed"] })) : null;
        return { summary, meetings };
      });
      if (done === null) return NextResponse.json({ ok: false, error: "A push is already running for this client (the automatic sync, or another click). Try again in a minute." }, { status: 409 });
      return reply(done);
    }
    if (action === "auto") {
      if (destination.status !== "built") return NextResponse.json({ ok: false, error: "Approve and apply the build first." }, { status: 400 });
      await saveDestination(c, workspace.id, "crm", { auto_push: body.on === true });
      return reply();
    }
    if (action === "reporting") {
      const blocked = await scopeGate();
      if (blocked) return blocked;
      if (!hubspotAppConfigured()) return NextResponse.json({ ok: false, error: "QC Growth's HubSpot app keys are not on Vercel yet." }, { status: 400 });
      const userToken = await hubspotUserToken(c, destination);
      if (!userToken) return NextResponse.json({ ok: false, error: "Connect the QC Growth user first." }, { status: 400 });
      // One build at a time per client: a second click while one runs gets told to wait instead of building again.
      const outcome = await withPushLock(c, workspace.id, "reporting", 240_000, async () => {
        const reporting = await hubspotBuildReporting(userToken);
        const fresh = (await loadDestination(c, workspace.id, "crm")) ?? destination;
        const userView = reporting.pending || fresh.config?.view_user_id ? null : await hubspotUserView(userToken, (fresh.audit as { qcView?: { id: string } } | null)?.qcView?.id ?? null);
        if (userView) reporting.log.push(userView.log);
        await saveDestination(c, workspace.id, "crm", { build_log: [...(fresh.build_log ?? []), ...reporting.log] as unknown as Row[], config: { ...(fresh.config ?? {}), ...(reporting.dashboardId ? { dashboard_id: reporting.dashboardId } : {}), ...(userView?.viewId ? { view_user_id: userView.viewId } : {}) } });
        return reporting;
      });
      if (!outcome) return NextResponse.json({ ok: false, error: "Already building the reports for this client. Give it a minute." }, { status: 409 });
      if (outcome.pending) return reply({ built: false, pending: true, failed: [REPORTING_WAIT] });
      const failed = outcome.log.filter((entry) => entry.result === "failed");
      return reply({ built: !failed.length, failed: failed.map((entry) => `${entry.name}: ${entry.detail}`) });
    }
    if (action === "disconnect_user") {
      const { hubspot_user: _, ...rest } = (destination.config ?? {}) as Row;
      await saveDestination(c, workspace.id, "crm", { config: rest });
      return reply();
    }
    if (action === "disconnect") {
      await saveDestination(c, workspace.id, "crm", { api_key: null, status: "disconnected", auto_push: false });
      return reply();
    }
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "That step failed." }, { status: 500 });
  }
}
