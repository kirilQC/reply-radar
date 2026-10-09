// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { loadDestination, presentDestination, rows, saveDestination, type Destination } from "../../../lib/crm-push";
import { pushOne, pushPass } from "../../../lib/crm-push-run";
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
      // The key's scopes are asked for again: ticking a scope in HubSpot must clear the warning on re-read.
      const account = await hubspotConnect(destination.api_key);
      const audit = await hubspotAudit(destination.api_key, account.scopes);
      await saveDestination(c, workspace.id, "crm", { audit: audit as unknown as Row, plan: hubspotPlan(audit) as unknown as Row, status: destination.status === "built" ? "built" : "planned" });
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
      const approved: HubSpotPlan = { ...plan, items, settings: choices.useLeadSource === false ? { ...settings, leadSourceProperty: null, leadSourceValue: null } : settings };
      const log = await hubspotApply(destination.api_key, approved);
      const failed = log.filter((entry) => entry.result === "failed");
      await saveDestination(c, workspace.id, "crm", { plan: approved as unknown as Row, build_log: [...(destination.build_log ?? []), ...log] as unknown as Row[], status: failed.length ? "planned" : "built" });
      return reply({ built: !failed.length, failed: failed.map((entry) => `${entry.name}: ${entry.detail}`) });
    }
    // Read-only: which HubSpot surfaces this client's key can reach (saved views, reports, segments, HubSQL),
    // so the cockpit only offers what the key can actually build. Status codes only, never data.
    if (action === "probe") {
      const token = destination.api_key;
      const probes: Array<[string, string, string, unknown?]> = [
        ["views (CLI backend)", "GET", "/hub/cli/backend/crm/contacts/views"],
        ["reports list", "GET", "/dashboard/v2/reports?limit=1"],
        ["reports (reporting v1 fetch)", "GET", "/reporting/v1/reports/fetch?limit=1"],
        ["segments (public lists API)", "POST", "/crm/v3/lists/search", { count: 1, processingTypes: ["DYNAMIC"] }],
        ["segments (CLI backend)", "GET", "/hub/cli/backend/v1/segments/search?limit=1"],
        ["HubSQL query", "POST", "/analytics/hubsql/2027-03-beta/query", { query: "SELECT COUNT(*) FROM contacts" }],
        ["dashboards search (reporting beta)", "GET", "/analytics/reporting/2027-03-beta/dashboards?limit=1"],
        ["reports search (reporting beta)", "GET", "/analytics/reporting/2027-03-beta/reports?limit=1"],
      ];
      const results: Array<{ name: string; status: number; message: string }> = [];
      for (const [name, method, path, body] of probes) {
        const response = await fetch(`https://api.hubapi.com${path}`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" }).catch(() => null);
        const raw = response ? await response.text().catch(() => "") : "";
        let message = "";
        try { message = String((JSON.parse(raw) as { message?: string; category?: string }).message ?? "").slice(0, 160); } catch { message = raw.slice(0, 80); }
        results.push({ name, status: response?.status ?? 0, message: response && response.ok ? "" : message });
      }
      const info = await fetch("https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenKey: token }), cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
      const scopes = (Array.isArray((info as { scopes?: unknown }).scopes) ? (info as { scopes: string[] }).scopes : []).filter((scope) => /report|dashboard|list|hubsql/i.test(scope));
      return NextResponse.json({ ok: true, probe: results, scopes });
    }
    if (action === "probe_write") {
      // Creates one TEST view, segment, report and dashboard with the client's key, reads each back, deletes them all.
      const token = destination.api_key;
      const call = async (method: string, path: string, payload?: unknown) => {
        const response = await fetch(`https://api.hubapi.com${path}`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: payload === undefined ? undefined : JSON.stringify(payload), cache: "no-store" }).catch(() => null);
        const raw = response ? await response.text().catch(() => "") : "";
        let json: Record<string, unknown> = {};
        try { json = JSON.parse(raw); } catch { /* empty */ }
        return { status: response?.status ?? 0, json, message: response?.ok ? "" : String(json.message ?? raw).slice(0, 200) };
      };
      const steps: Array<{ step: string; status: number; id?: string; detail?: string; message?: string }> = [];
      const platforms = ["heyreach", "lemlist", "email_bison"];
      const view = await call("POST", "/hub/cli/backend/crm/contacts/views", { name: "TEST QC Growth view", objectTypeId: "contacts", columns: [{ name: "firstname" }, { name: "lastname" }, { name: "qc_campaign" }, { name: "qc_last_reply_date" }], filterGroups: [{ filters: [{ property: "qc_outreach_platform", operator: "IN", values: platforms }] }], sort: { property: "qc_last_reply_date", direction: "DESCENDING" } });
      const viewId = String(view.json.id ?? "");
      steps.push({ step: "view create", status: view.status, id: viewId, detail: view.message });
      if (viewId) { const back = await call("GET", `/hub/cli/backend/crm/contacts/views/${viewId}`); steps.push({ step: "view read back", status: back.status, detail: JSON.stringify(back.json.filterGroups ?? back.json.filters ?? "").slice(0, 200) }); }
      const list = await call("POST", "/crm/v3/lists", { name: "TEST QC Growth segment", objectTypeId: "0-1", processingType: "DYNAMIC", filterBranch: { filterBranchType: "OR", filters: [], filterBranches: [{ filterBranchType: "AND", filterBranches: [], filters: [{ filterType: "PROPERTY", property: "qc_outreach_platform", operation: { operationType: "ENUMERATION", operator: "IS_ANY_OF", values: platforms } }] }] } });
      const listId = String((list.json.list as { listId?: string } | undefined)?.listId ?? "");
      steps.push({ step: "segment create", status: list.status, id: listId, detail: list.message });
      const reportSql = "SELECT qc_campaign, COUNT(*) FROM CONTACT WHERE qc_outreach_platform IN ('heyreach', 'lemlist', 'email_bison') GROUP BY qc_campaign";
      const report = await call("POST", "/hub/cli/backend/reporting/v1/reports/create", { sql: reportSql, intent: reportSql, chartType: "BAR", name: "TEST QC replies by campaign" });
      steps.push({ step: "report create (cli backend)", status: report.status, id: String(report.json.id ?? ""), detail: report.message });
      const direct = report.json.id ? report : await call("POST", "/reporting/v1/reports/create", { sql: reportSql, intent: reportSql, chartType: "BAR", name: "TEST QC replies by campaign" });
      if (direct !== report) steps.push({ step: "report create (reporting v1)", status: direct.status, id: String(direct.json.id ?? ""), detail: direct.message });
      const reportId = String(direct.json.id ?? "");
      const dashboard = await call("POST", "/analytics/reporting/2027-03-beta/dashboards", { name: "TEST QC Growth dashboard", permissions: { permissionType: "EVERYONE_VIEW" }, ...(reportId ? { reportIdsToAdd: [reportId] } : {}) });
      const dashboardId = String(dashboard.json.id ?? "");
      steps.push({ step: "dashboard create", status: dashboard.status, id: dashboardId, detail: dashboard.message || `widgets: ${Array.isArray(dashboard.json.widgets) ? dashboard.json.widgets.length : "?"}` });
      if (body.keep === true) return NextResponse.json({ ok: true, steps, kept: true });
      if (dashboardId) steps.push({ step: "dashboard delete", ...(await call("DELETE", `/analytics/reporting/2027-03-beta/dashboards/${dashboardId}`)), id: dashboardId });
      for (const id of [reportId, ...(Array.isArray(body.extraReports) ? body.extraReports.map(String) : [])].filter(Boolean)) steps.push({ step: "report delete", ...(await call("DELETE", `/dashboard/v2/reports/${id}`)), id });
      if (listId) steps.push({ step: "segment delete", ...(await call("DELETE", `/crm/v3/lists/${listId}`)), id: listId });
      if (viewId) steps.push({ step: "view delete", ...(await call("DELETE", `/hub/cli/backend/crm/contacts/views/${viewId}`)), id: viewId });
      const info = await fetch("https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenKey: token }), cache: "no-store" }).then((r) => r.json()).catch(() => ({}));
      const scopes = (Array.isArray((info as { scopes?: unknown }).scopes) ? (info as { scopes: string[] }).scopes : []).filter((scope) => /report|dashboard|list/i.test(scope));
      return NextResponse.json({ ok: true, scopes, steps: steps.map(({ step, status, id, detail, message }) => ({ step, status, id, detail: detail ?? message })) });
    }
    if (action === "push_one") {
      return reply({ test: await pushOne(c, destination as Destination) });
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
