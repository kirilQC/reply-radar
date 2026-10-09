// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { hubspot, HubSpotError, QC_VIEW_NAME, QC_VIEW_PATH, qcViewBody, type BuildLogEntry } from "./hubspot-push";

/**
 * QC Growth's reports and dashboard in a client's HubSpot, built as the QC Growth user (hubspot-user.ts).
 * Reports are created from HubSQL through HubSpot's CLI backend (the public Reporting API cannot create a
 * report yet); the dashboard through the Reporting API beta. Everything is found by name first, so a re-run
 * reuses what is there and only adds what is missing. Every query is limited to contacts QC brought in.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const list = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

const QC_ONLY = "WHERE qc_outreach_platform IN ('heyreach', 'lemlist', 'email_bison')";
export const QC_DASHBOARD_NAME = "QC Growth";

export const QC_REPORTS: Array<{ name: string; chartType: string; sql: string }> = [
  { name: "QC Growth · Leads who replied", chartType: "KPI", sql: `SELECT COUNT(*) FROM CONTACT ${QC_ONLY}` },
  // Monthly: HubSpot saves a WEEK grouping as YEAR (tested 2026-10-09), MONTH holds.
  { name: "QC Growth · Replies by month", chartType: "COLUMN", sql: `SELECT DATE_TRUNC(qc_first_reply_date, 'MONTH'), COUNT(*) FROM CONTACT ${QC_ONLY} GROUP BY DATE_TRUNC(qc_first_reply_date, 'MONTH')` },
  { name: "QC Growth · Replies by campaign", chartType: "HORIZONTAL_BAR", sql: `SELECT qc_campaign, COUNT(*) FROM CONTACT ${QC_ONLY} GROUP BY qc_campaign ORDER BY COUNT(*) DESC` },
  { name: "QC Growth · Reply sentiment", chartType: "DONUT", sql: `SELECT qc_reply_sentiment, COUNT(*) FROM CONTACT ${QC_ONLY} GROUP BY qc_reply_sentiment` },
  { name: "QC Growth · Replies by platform", chartType: "DONUT", sql: `SELECT qc_outreach_platform, COUNT(*) FROM CONTACT ${QC_ONLY} GROUP BY qc_outreach_platform` },
  { name: "QC Growth · Replies by sender", chartType: "BAR", sql: `SELECT qc_sender, COUNT(*) FROM CONTACT ${QC_ONLY} GROUP BY qc_sender ORDER BY COUNT(*) DESC` },
  { name: "QC Growth · Latest replies", chartType: "TABLE", sql: `SELECT firstname, lastname, company, jobtitle, qc_campaign, qc_reply_sentiment, qc_reply_count, qc_last_reply_date FROM CONTACT ${QC_ONLY} ORDER BY qc_last_reply_date DESC LIMIT 100` },
];

const BETA = "/analytics/reporting/2027-03-beta";

/** Every QC item of one kind by lower-cased name, all ids per name (oldest first). Throws when HubSpot refuses. */
async function allByName(token: string, kind: "reports" | "dashboards", prefix: string): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  let after = "";
  for (let page = 0; page < 20; page++) {
    const data = await hubspot(token, "GET", `${BETA}/${kind}?q=${encodeURIComponent(prefix)}&limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    for (const row of list(data.results)) {
      const name = text(row.name).toLowerCase();
      if (name && text(row.id)) found.set(name, [...(found.get(name) ?? []), text(row.id)]);
    }
    after = text(((data.paging as Row | undefined)?.next as Row | undefined)?.after);
    if (!after) break;
  }
  for (const [name, ids] of found) found.set(name, [...new Set(ids)].sort((x, y) => Number(x) - Number(y)));
  return found;
}

/** HubSpot gates the Reporting API per account; a freshly joined beta takes a few minutes to switch on. */
export const reportingNotReady = (error: unknown) => error instanceof HubSpotError && (error.status === 403 || /ungated/i.test(error.message));

export const REPORTING_WAIT = "HubSpot has not switched on the Reporting API beta for this account yet (it takes a few minutes after joining). Nothing was built. Try again in a minute.";

/**
 * Builds (or tops up) the QC Growth reports and dashboard, never twice: it first reads what is already there and
 * stops without creating anything when it cannot (beta not switched on yet), keeps one report per name (the one
 * on the dashboard, else the oldest) and deletes any extra copies left by earlier runs.
 */
export async function hubspotBuildReporting(token: string): Promise<{ log: BuildLogEntry[]; dashboardId: string | null; pending?: boolean }> {
  const log: BuildLogEntry[] = [];
  const at = () => new Date().toISOString();
  let reports: Map<string, string[]>;
  let dashboards: Map<string, string[]>;
  try {
    [dashboards, reports] = await Promise.all([allByName(token, "dashboards", QC_DASHBOARD_NAME), allByName(token, "reports", "QC Growth")]);
  } catch (error) {
    const waiting = reportingNotReady(error);
    log.push({ at: at(), kind: "dashboard", name: QC_DASHBOARD_NAME, result: waiting ? "waiting" : "failed", detail: waiting ? REPORTING_WAIT : `Could not read the reports already there, so nothing was built: ${error instanceof Error ? error.message.slice(0, 200) : ""}` });
    return { log, dashboardId: null, pending: waiting };
  }

  let dashboardId = dashboards.get(QC_DASHBOARD_NAME.toLowerCase())?.[0] ?? null;
  for (const extra of dashboards.get(QC_DASHBOARD_NAME.toLowerCase())?.slice(1) ?? []) {
    await hubspot(token, "DELETE", `${BETA}/dashboards/${extra}`)
      .then(() => log.push({ at: at(), kind: "dashboard", name: QC_DASHBOARD_NAME, result: "removed", detail: `Duplicate dashboard ${extra}` }))
      .catch((error) => log.push({ at: at(), kind: "dashboard", name: QC_DASHBOARD_NAME, result: "failed", detail: `Could not remove duplicate ${extra}: ${error instanceof Error ? error.message.slice(0, 160) : ""}` }));
  }
  const onDashboard = new Set<string>();
  if (dashboardId) {
    const current = await hubspot(token, "GET", `${BETA}/dashboards/${dashboardId}?properties=widgets`).catch(() => ({} as Row));
    for (const widget of list(current.widgets)) onDashboard.add(text(widget.reportId ?? (widget.report as Row | undefined)?.id ?? widget.id));
  }

  const reportIds: string[] = [];
  for (const report of QC_REPORTS) {
    const ids = reports.get(report.name.toLowerCase()) ?? [];
    const keep = ids.find((id) => onDashboard.has(id)) ?? ids[0];
    for (const extra of ids.filter((id) => id !== keep)) {
      await hubspot(token, "DELETE", `${BETA}/reports/${extra}`)
        .then(() => log.push({ at: at(), kind: "report", name: report.name, result: "removed", detail: `Duplicate report ${extra}` }))
        .catch((error) => log.push({ at: at(), kind: "report", name: report.name, result: "failed", detail: `Could not remove duplicate ${extra}: ${error instanceof Error ? error.message.slice(0, 160) : ""}` }));
    }
    if (keep) {
      reportIds.push(keep);
      log.push({ at: at(), kind: "report", name: report.name, result: "reused", detail: `Report ${keep}` });
      continue;
    }
    try {
      const created = await hubspot(token, "POST", "/hub/cli/backend/reporting/v1/reports/create", { sql: report.sql, intent: report.sql, chartType: report.chartType, name: report.name });
      reportIds.push(text(created.id));
      log.push({ at: at(), kind: "report", name: report.name, result: "created", detail: `Report ${text(created.id)}` });
    } catch (error) {
      log.push({ at: at(), kind: "report", name: report.name, result: "failed", detail: error instanceof Error ? error.message : "" });
    }
  }

  try {
    if (!dashboardId) {
      const created = await hubspot(token, "POST", `${BETA}/dashboards`, { name: QC_DASHBOARD_NAME, description: "Replies from QC Growth's outreach, kept up to date by QC Growth.", permissions: { permissionType: "EVERYONE_VIEW" }, reportIdsToAdd: reportIds });
      dashboardId = text(created.id);
      log.push({ at: at(), kind: "dashboard", name: QC_DASHBOARD_NAME, result: "created", detail: `Dashboard ${dashboardId}, ${list(created.widgets).length} of ${reportIds.length} reports on it` });
    } else {
      let added = 0;
      for (const id of reportIds.filter((reportId) => !onDashboard.has(reportId))) {
        await hubspot(token, "PUT", `${BETA}/dashboards/${dashboardId}/widgets/${id}`).then(() => added++).catch(() => undefined);
      }
      log.push({ at: at(), kind: "dashboard", name: QC_DASHBOARD_NAME, result: "reused", detail: `Dashboard ${dashboardId}${added ? `, ${added} reports added` : ""}` });
    }
  } catch (error) {
    log.push({ at: at(), kind: "dashboard", name: QC_DASHBOARD_NAME, result: reportingNotReady(error) ? "waiting" : "failed", detail: reportingNotReady(error) ? REPORTING_WAIT : error instanceof Error ? error.message : "" });
  }
  return { log, dashboardId };
}

/**
 * The QC Growth view, owned by the QC Growth user. A view the service key made shows as made by a
 * "Deactivated" user, and HubSpot will not keep it open as a tab; one made by a real user stays. So once the
 * QC Growth user is signed in, the view is made again as them and the key's copy is removed.
 */
export async function hubspotUserView(token: string, keyViewId: string | null): Promise<{ log: BuildLogEntry; viewId: string | null }> {
  const at = new Date().toISOString();
  try {
    const created = await hubspot(token, "POST", QC_VIEW_PATH, qcViewBody());
    const viewId = text(created.id);
    if (keyViewId && keyViewId !== viewId) await hubspot(token, "DELETE", `${QC_VIEW_PATH}/${keyViewId}`).catch(() => undefined);
    return { viewId, log: { at, kind: "view", name: QC_VIEW_NAME, result: "created", detail: `Contacts view ${viewId}, owned by the QC Growth user${keyViewId ? ` (replaced ${keyViewId})` : ""}` } };
  } catch (error) {
    return { viewId: null, log: { at, kind: "view", name: QC_VIEW_NAME, result: "failed", detail: error instanceof Error ? error.message : "" } };
  }
}
