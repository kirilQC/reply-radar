// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { loadDestination, presentDestination, rows, saveDestination, withPushLock, type Destination } from "../../../lib/crm-push";
import { pushOne, pushPass } from "../../../lib/crm-push-run";
import { hubspotApply, hubspotAudit, hubspotConnect, hubspotPlan, type HubSpotPlan } from "../../../lib/hubspot-push";
import { hubspotBuildReporting, hubspotUserView } from "../../../lib/hubspot-reporting";
import { dealsApply, dealsAudit, dealsPlan, type DealsPlan } from "../../../lib/hubspot-deals";
import { pushMeetingsPass } from "../../../lib/meetings-deals-run";
import { attioDealsApply, attioDealsAudit, attioDealsPlan, type AttioDealsPlan } from "../../../lib/attio-deals";
import { attioApply, attioAudit, attioConnect, attioPlan, type AttioPlan } from "../../../lib/attio-push";
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
    return NextResponse.json({ ok: true, hubspotApp: hubspotAppConfigured(), crm: presentDestination(await loadDestination(c, workspace.id, "crm")) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not read the CRM settings." }, { status: 500 });
  }
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
    if (action === "apply" && destination.provider === "attio") {
      const plan = destination.plan as unknown as AttioPlan;
      const choices = (body.settings && typeof body.settings === "object" ? body.settings : {}) as Row;
      const approved: AttioPlan & { deals?: AttioDealsPlan } = { ...plan, settings: { ...plan.settings, ...(text(choices.ownerId) ? { ownerId: text(choices.ownerId) } : {}) } };
      const log = await attioApply(destination.api_key, approved);
      const planDeals = (plan as AttioPlan & { deals?: AttioDealsPlan }).deals;
      if (planDeals) {
        const deals: AttioDealsPlan = { ...planDeals, enabled: choices.pushDeals === undefined ? planDeals.enabled : choices.pushDeals === true && planDeals.available };
        log.push(...(await attioDealsApply(destination.api_key, deals)));
        approved.deals = { ...deals, statusExists: deals.enabled ? true : deals.statusExists, createAttributes: deals.enabled ? [] : deals.createAttributes };
      }
      const failed = log.filter((entry) => entry.result === "failed");
      await saveDestination(c, workspace.id, "crm", { plan: approved as unknown as Row, build_log: [...(destination.build_log ?? []), ...log] as unknown as Row[], status: failed.length ? "planned" : "built", ...(!failed.length && destination.status !== "built" ? { auto_push: true } : {}) });
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
      const planDeals = (plan as HubSpotPlan & { deals?: DealsPlan }).deals;
      if (planDeals) {
        const pipelineId = text(choices.dealPipelineId) || planDeals.pipelineId;
        const chosen = pipelineId !== planDeals.pipelineId ? dealsPlan(await dealsAudit(destination.api_key), { ...planDeals, pipelineId }) : planDeals;
        const deals: DealsPlan = { ...chosen, enabled: choices.pushDeals === undefined ? chosen.enabled : choices.pushDeals === true };
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
      await saveDestination(c, workspace.id, "crm", { plan: approved as unknown as Row, build_log: [...(destination.build_log ?? []), ...log] as unknown as Row[], status: failed.length ? "planned" : "built", ...(!failed.length && destination.status !== "built" ? { auto_push: true } : {}) });
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
    if (action === "disconnect") {
      await saveDestination(c, workspace.id, "crm", { api_key: null, status: "disconnected", auto_push: false });
      return reply();
    }
    return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "That step failed." }, { status: 500 });
  }
}
