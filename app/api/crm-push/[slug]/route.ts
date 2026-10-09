// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { loadDestination, presentDestination, rows, saveDestination, type Destination } from "../../../lib/crm-push";
import { pushPass } from "../../../lib/crm-push-run";
import { hubspotApply, hubspotAudit, hubspotConnect, hubspotPlan, type HubSpotAudit, type HubSpotPlan } from "../../../lib/hubspot-push";

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
    return NextResponse.json({ ok: true, crm: presentDestination(await loadDestination(c, workspace.id, "crm")) });
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
    const reply = async (extra: Row = {}) => NextResponse.json({ ok: true, ...extra, crm: presentDestination(await loadDestination(c, workspace.id, "crm")) });

    if (action === "connect") {
      const provider = text(body.provider);
      const apiKey = text(body.apiKey);
      if (provider !== "hubspot") return NextResponse.json({ ok: false, error: provider === "attio" ? "Attio is next; HubSpot first." : "Choose HubSpot or Attio." }, { status: 400 });
      if (!apiKey) return NextResponse.json({ ok: false, error: "Paste the client's HubSpot service key." }, { status: 400 });
      const account = await hubspotConnect(apiKey);
      // One portal, one client: a key for a portal already linked to another client is refused.
      const clash = await rows(c, `rr_crm_push?select=workspace_id&provider=eq.hubspot&account_id=eq.${encodeURIComponent(account.portalId)}&workspace_id=neq.${encodeURIComponent(workspace.id)}&limit=1`);
      if (clash.length) return NextResponse.json({ ok: false, error: `HubSpot portal ${account.portalId} is already connected to another client. Check you are in ${workspace.name}'s HubSpot.` }, { status: 409 });
      const audit = await hubspotAudit(apiKey, account.scopes);
      const plan = hubspotPlan(audit);
      await saveDestination(c, workspace.id, "crm", { provider: "hubspot", api_key: apiKey, account_id: account.portalId, account_name: account.name, status: "planned", audit: audit as unknown as Row, plan: plan as unknown as Row, build_log: [], auto_push: false });
      return reply();
    }
    if (!destination?.api_key) return NextResponse.json({ ok: false, error: "Connect the CRM first." }, { status: 400 });

    if (action === "replan") {
      const audit = await hubspotAudit(destination.api_key, (destination.audit as HubSpotAudit | null)?.scopes ?? []);
      await saveDestination(c, workspace.id, "crm", { audit: audit as unknown as Row, plan: hubspotPlan(audit) as unknown as Row, status: destination.status === "built" ? "built" : "planned" });
      return reply();
    }
    if (action === "apply") {
      const plan = destination.plan as unknown as HubSpotPlan;
      // The person's choices on the plan: owner for new contacts, lifecycle on create, the lead source option.
      const choices = (body.settings && typeof body.settings === "object" ? body.settings : {}) as Row;
      const settings = {
        ...plan.settings,
        ...(choices.ownerId !== undefined ? { ownerId: text(choices.ownerId) || null } : {}),
        ...(choices.lifecycleOnCreate !== undefined ? { lifecycleOnCreate: choices.lifecycleOnCreate ? "lead" : null } : {}),
      };
      const items = choices.useLeadSource === false ? plan.items.map((item) => (item.kind === "option" ? { ...item, action: "skip" as const } : item)) : plan.items;
      const approved: HubSpotPlan = { ...plan, items, settings: choices.useLeadSource === false ? { ...settings, leadSourceProperty: null, leadSourceValue: null } : settings };
      const log = await hubspotApply(destination.api_key, approved);
      const failed = log.filter((entry) => entry.result === "failed");
      await saveDestination(c, workspace.id, "crm", { plan: approved as unknown as Row, build_log: [...(destination.build_log ?? []), ...log] as unknown as Row[], status: failed.length ? "planned" : "built" });
      return reply({ built: !failed.length, failed: failed.map((entry) => `${entry.name}: ${entry.detail}`) });
    }
    if (action === "push") {
      const summary = await pushPass(c, destination as Destination, { offset: Number(body.offset) || 0, budgetMs: 240_000 });
      return reply({ summary });
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
