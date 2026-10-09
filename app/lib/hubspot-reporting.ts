// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { hubspot, HubSpotError, type BuildLogEntry } from "./hubspot-push";

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
  { name: "QC Growth · Replies over time", chartType: "LINE", sql: `SELECT DATE_TRUNC(qc_first_reply_date, 'WEEK'), COUNT(*) FROM CONTACT ${QC_ONLY} GROUP BY DATE_TRUNC(qc_first_reply_date, 'WEEK')` },
  { name: "QC Growth · Replies by campaign", chartType: "HORIZONTAL_BAR", sql: `SELECT qc_campaign, COUNT(*) FROM CONTACT ${QC_ONLY} GROUP BY qc_campaign ORDER BY COUNT(*) DESC` },
  { name: "QC Growth · Reply sentiment", chartType: "DONUT", sql: `SELECT qc_reply_sentiment, COUNT(*) FROM CONTACT ${QC_ONLY} GROUP BY qc_reply_sentiment` },
  { name: "QC Growth · Replies by platform", chartType: "DONUT", sql: `SELECT qc_outreach_platform, COUNT(*) FROM CONTACT ${QC_ONLY} GROUP BY qc_outreach_platform` },
  { name: "QC Growth · Replies by sender", chartType: "BAR", sql: `SELECT qc_sender, COUNT(*) FROM CONTACT ${QC_ONLY} GROUP BY qc_sender ORDER BY COUNT(*) DESC` },
  { name: "QC Growth · Latest replies", chartType: "TABLE", sql: `SELECT firstname, lastname, company, jobtitle, qc_campaign, qc_reply_sentiment, qc_reply_count, qc_last_reply_date FROM CONTACT ${QC_ONLY} ORDER BY qc_last_reply_date DESC LIMIT 100` },
];

const BETA = "/analytics/reporting/2027-03-beta";

async function byName(token: string, kind: "reports" | "dashboards", prefix: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const data = await hubspot(token, "GET", `${BETA}/${kind}?q=${encodeURIComponent(prefix)}&limit=100`).catch(() => ({} as Row));
  for (const row of list(data.results)) if (text(row.name)) found.set(text(row.name).toLowerCase(), text(row.id));
  return found;
}

/** Builds (or tops up) the QC Growth reports and dashboard. Returns build log entries like hubspotApply. */
export async function hubspotBuildReporting(token: string): Promise<{ log: BuildLogEntry[]; dashboardId: string | null }> {
  const log: BuildLogEntry[] = [];
  const at = () => new Date().toISOString();
  const existing = await byName(token, "reports", "QC Growth");
  const reportIds: string[] = [];
  for (const report of QC_REPORTS) {
    const id = existing.get(report.name.toLowerCase());
    if (id) {
      reportIds.push(id);
      log.push({ at: at(), kind: "report", name: report.name, result: "reused", detail: `Report ${id}` });
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
  let dashboardId = (await byName(token, "dashboards", QC_DASHBOARD_NAME)).get(QC_DASHBOARD_NAME.toLowerCase()) ?? null;
  try {
    if (!dashboardId) {
      const created = await hubspot(token, "POST", `${BETA}/dashboards`, { name: QC_DASHBOARD_NAME, description: "Replies from QC Growth's outreach, kept up to date by QC Growth.", permissions: { permissionType: "EVERYONE_VIEW" }, reportIdsToAdd: reportIds });
      dashboardId = text(created.id);
      const widgets = list(created.widgets).length;
      log.push({ at: at(), kind: "dashboard", name: QC_DASHBOARD_NAME, result: "created", detail: `Dashboard ${dashboardId}, ${widgets} of ${reportIds.length} reports on it` });
    } else {
      const current = await hubspot(token, "GET", `${BETA}/dashboards/${dashboardId}?properties=widgets`);
      const onIt = new Set(list(current.widgets).map((widget) => text(widget.reportId ?? (widget.report as Row | undefined)?.id ?? widget.id)));
      let added = 0;
      for (const id of reportIds.filter((reportId) => !onIt.has(reportId))) {
        await hubspot(token, "PUT", `${BETA}/dashboards/${dashboardId}/widgets/${id}`).then(() => added++).catch(() => undefined);
      }
      log.push({ at: at(), kind: "dashboard", name: QC_DASHBOARD_NAME, result: "reused", detail: `Dashboard ${dashboardId}${added ? `, ${added} reports added` : ""}` });
    }
  } catch (error) {
    log.push({ at: at(), kind: "dashboard", name: QC_DASHBOARD_NAME, result: "failed", detail: error instanceof HubSpotError && error.status === 403 ? "HubSpot refused: the QC Growth user needs reporting access in this account." : error instanceof Error ? error.message : "" });
  }
  return { log, dashboardId };
}
