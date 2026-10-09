// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { rows, withPushLock, type Config, type Destination } from "./crm-push";
import { pushPass, recordKey } from "./crm-push-run";
import { pushMeetingsPass } from "./meetings-deals-run";
import { sheetsPushMeetings } from "./sheets-push";

/**
 * Where each client's replies and booked meetings go outside QC Command, for Scout, the MCP route and QC Bot:
 * the CRM (HubSpot or Attio) with its build, owner, dashboard, deals setup and push results, and every Google
 * Sheet with what it holds. Read from safe columns only: never api_key, never the stored sign-ins in config.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const enc = encodeURIComponent;

const SAFE = "workspace_id,kind,provider,account_id,account_name,status,auto_push,last_push_at,last_push_summary,plan,config,created_at";

function summary(value: unknown) {
  const s = object(value);
  if (!Object.keys(s).length) return null;
  return { pushed: Number(s.pushed) || 0, created: Number(s.created) || 0, updated: Number(s.updated) || 0, failed: Number(s.failed) || 0, errors: Array.isArray(s.errors) ? (s.errors as unknown[]).map(text).slice(0, 5) : [] };
}

function crmLinks(row: Row) {
  const config = object(row.config);
  const plan = object(row.plan);
  const portal = text(row.account_id);
  const host = text(row.account_name).includes("hubspot.com") ? text(row.account_name) : "app.hubspot.com";
  if (row.provider === "hubspot") {
    return {
      dashboard: config.dashboard_id ? `https://${host}/reports-dashboard/${portal}/view/${text(config.dashboard_id)}` : null,
      contactsView: config.view_user_id ? `https://${host}/contacts/${portal}/objects/0-1/views/${text(config.view_user_id)}/list` : null,
    };
  }
  if (row.provider === "attio") {
    const slug = text(config.attio_slug);
    const listId = text(object(plan.settings).listId);
    return {
      qcGrowthList: slug && listId ? `https://app.attio.com/${slug}/collection/${listId}` : null,
      qcDashboardApp: slug ? `https://app.attio.com/${slug}/apps/qc-growth-dashboard/qc-growth` : null,
    };
  }
  return {};
}

export async function crmSyncStatus(config: Config, workspaceIds: string[] | null, names: Map<string, string>) {
  const scope = workspaceIds ? `&workspace_id=in.(${workspaceIds.map(enc).join(",")})` : "";
  const destinations = await rows(config, `rr_crm_push?select=${SAFE}${scope}&api_key=not.is.null&order=created_at.asc`);
  const ids = [...new Set(destinations.map((row) => text(row.workspace_id)))];
  const [records, deals] = ids.length
    ? await Promise.all([
        rows(config, `rr_crm_push_records?select=workspace_id,provider,error&workspace_id=in.(${ids.map(enc).join(",")})&limit=50000`).catch(() => [] as Row[]),
        rows(config, `rr_crm_push_meetings?select=workspace_id,provider,deal_id,error&workspace_id=in.(${ids.map(enc).join(",")})&limit=20000`).catch(() => [] as Row[]),
      ])
    : [[], []];
  const count = (list: Row[], workspace: string, provider: string) => {
    const mine = list.filter((row) => text(row.workspace_id) === workspace && text(row.provider) === provider);
    // Deals: several bookings by one person share a deal, so count distinct deals, not bookings.
    const distinct = new Set(mine.map((row) => text(row.deal_id)).filter(Boolean));
    return { total: "deal_id" in (mine[0] ?? {}) ? distinct.size : mine.length, failing: mine.filter((row) => text(row.error)).length, sampleErrors: mine.filter((row) => text(row.error)).slice(0, 3).map((row) => text(row.error).slice(0, 160)) };
  };

  const clients = new Map<string, Row>();
  for (const row of destinations) {
    const workspace = text(row.workspace_id);
    const entry = clients.get(workspace) ?? { client: names.get(workspace) ?? "(unknown client)", crm: null, sheets: [] as Row[] };
    const plan = object(row.plan);
    const kind = text(row.kind);
    if (kind === "crm") {
      const deals_ = object(plan.deals);
      const settings = object(plan.settings);
      const pushed = count(records, workspace, text(row.provider));
      const dealCount = count(deals, workspace, text(row.provider));
      entry.crm = {
        provider: row.provider === "hubspot" ? "HubSpot" : row.provider === "attio" ? "Attio" : text(row.provider),
        account: text(row.account_name),
        built: row.status === "built",
        status: text(row.status),
        pushNewRepliesAutomatically: row.auto_push === true,
        lastPush: text(row.last_push_at) || null,
        lastPushResult: summary(row.last_push_summary),
        repliesPushed: pushed.total,
        repliesFailing: pushed.failing,
        replyErrors: pushed.sampleErrors,
        qcGrowthUserSignedIn: row.provider === "hubspot" ? Boolean(object(object(row.config).hubspot_user).refresh_token) : undefined,
        ownerOfNewRecords: text(settings.ownerId) ? "QC Growth" : "not set",
        bookedMeetingsToDeals: Object.keys(deals_).length
          ? {
              on: deals_.enabled === true,
              where: row.provider === "hubspot" ? `${text(deals_.pipelineLabel) || "pipeline"} → Booked Meeting (QC)` : "Deals → Booked Meeting (QC)",
              stageReady: row.provider === "hubspot" ? Boolean(deals_.stageId) : deals_.statusExists === true,
              dealsPushed: dealCount.total,
              dealsFailing: dealCount.failing,
              dealErrors: dealCount.sampleErrors,
            }
          : { on: false },
        links: crmLinks(row),
      };
    } else {
      const sheetConfig = object(row.config);
      const pushed = count(records, workspace, recordKey(row as unknown as Destination));
      (entry.sheets as Row[]).push({
        sheet: `${text(row.account_name)} · ${text(sheetConfig.tab)}`,
        holds: sheetConfig.content === "meetings" ? "booked meetings (one row per person)" : "replies (one row per conversation)",
        mappingConfirmed: row.status === "built",
        columnsMapped: Array.isArray(sheetConfig.mapping) ? (sheetConfig.mapping as unknown[]).filter(Boolean).length : 0,
        pushAutomatically: row.auto_push === true,
        lastPush: text(row.last_push_at) || null,
        lastPushResult: summary(row.last_push_summary),
        rowsPushed: sheetConfig.content === "meetings" ? undefined : pushed.total,
        url: text(sheetConfig.url) || null,
      });
    }
    clients.set(workspace, entry);
  }
  const missing = (workspaceIds ?? []).filter((id) => !clients.has(id)).map((id) => ({ client: names.get(id) ?? "(unknown client)", crm: null, sheets: [], note: "No CRM or Google Sheet connected. Connect one from the client's onboarding page (HubSpot, Attio or Google Sheets logo)." }));
  return [...clients.values(), ...missing];
}

/**
 * Pushes a client's replies and booked meetings now, to their CRM and every sheet, the same as the automatic
 * sync does (new and changed conversations since the last push), instead of waiting for the next run.
 */
export async function crmPushNow(config: Config, workspaceId: string) {
  const destinations = (await rows(config, `rr_crm_push?select=*&workspace_id=eq.${enc(workspaceId)}&status=eq.built&api_key=not.is.null`)) as unknown as Destination[];
  if (!destinations.length) return { pushed: [], note: "This client has no built CRM or sheet to push to." };
  const out: Row[] = [];
  for (const destination of destinations) {
    const where = destination.kind === "crm" ? (destination.provider === "hubspot" ? "HubSpot" : "Attio") : `Sheet ${text(destination.account_name)}`;
    const last = Date.parse(destination.last_push_at ?? "");
    const since = new Date((Number.isNaN(last) ? Date.now() - 86_400_000 : last) - 15 * 60_000).toISOString();
    try {
      const done = await withPushLock(config, workspaceId, destination.kind, 300_000, async () => {
        const replies = await pushPass(config, destination, { since, budgetMs: 45_000 });
        const meetings = destination.provider === "google_sheets"
          ? (object(destination.config).content === "meetings" ? await sheetsPushMeetings(config, destination, { since }) : null)
          : await pushMeetingsPass(config, destination, { since, budgetMs: 30_000 });
        return { where, replies: { pushed: replies.pushed, failed: replies.failed, errors: replies.errors }, meetings };
      });
      out.push(done ?? { where, note: "A push was already running for this; it will have sent the latest." });
    } catch (error) {
      out.push({ where, error: error instanceof Error ? error.message.slice(0, 200) : "failed" });
    }
  }
  return { pushed: out };
}
