// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextRequest, NextResponse } from "next/server";

type Row = Record<string, unknown>;
type AuditEvent = {
  id: string;
  timestamp: string;
  source: string;
  sourceKey: string;
  action: string;
  status: string;
  severity: "success" | "info" | "warning" | "error";
  workspace: string | null;
  workspaceLogo: string | null;
  summary: string;
  details: Row;
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const statusSeverity = (statusValue: unknown): AuditEvent["severity"] => {
  const status = text(statusValue).toLowerCase();
  if (["failed", "error", "rejected"].includes(status)) return "error";
  if (["pending", "processing", "running", "started"].includes(status)) return "warning";
  if (["success", "processed", "completed"].includes(status)) return "success";
  return "info";
};

async function getJson(url: string, key: string, path: string) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  const data = await response.json().catch(() => []);
  if (!response.ok) throw new Error(`${path.split("?")[0]} returned ${response.status}`);
  return Array.isArray(data) ? data as Row[] : [];
}

function syncSummary(row: Row, workspace: string | null) {
  const source = text(row.source);
  const status = text(row.status) || "unknown";
  const seen = Number(row.records_seen ?? 0);
  const written = Number(row.records_written ?? 0);
  const error = text(row.error_text);
  if (source === "ai_ark") {
    if (status === "success") return `AI Ark enriched a LinkedIn profile${workspace ? ` for ${workspace}` : ""} and saved the result to Supabase.`;
    if (status === "failed") return `AI Ark could not enrich a LinkedIn profile${workspace ? ` for ${workspace}` : ""}${error ? `: ${error}` : "."}`;
    return `AI Ark started enriching a LinkedIn profile${workspace ? ` for ${workspace}` : ""}.`;
  }
  if (source === "render-worker-heartbeat" || text(row.run_type) === "heartbeat") {
    return status === "failed"
      ? `The background worker check failed${error ? `: ${error}` : "."}`
      : `The background worker checked ${seen} client${seen === 1 ? "" : "s"} and wrote ${written} update${written === 1 ? "" : "s"}.`;
  }
  return status === "failed"
    ? `The ${source || "background"} worker could not finish${workspace ? ` for ${workspace}` : ""}${error ? `: ${error}` : "."}`
    : `The ${source || "background"} worker finished${workspace ? ` for ${workspace}` : ""}, checking ${seen} record${seen === 1 ? "" : "s"} and writing ${written}.`;
}

function webhookSummary(row: Row, workspace: string | null) {
  const status = text(row.status) || "unknown";
  const eventType = text(row.event_type) || "reply event";
  const error = text(row.error_text);
  if (status === "failed") return `HeyReach sent ${eventType}${workspace ? ` for ${workspace}` : ""}, but Reply Radar could not finish processing it${error ? `: ${error}` : "."}`;
  if (status === "processing" || status === "pending") return `HeyReach sent ${eventType}${workspace ? ` for ${workspace}` : ""}; Reply Radar is processing it now.`;
  return `HeyReach sent ${eventType}${workspace ? ` for ${workspace}` : ""}, and Reply Radar stored it successfully.`;
}

export async function GET(request: NextRequest) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const params = request.nextUrl.searchParams;
  const limit = Math.min(100, Math.max(1, Number(params.get("limit") || 25)));
  const offset = Math.max(0, Number(params.get("offset") || 0));
  const sourceFilter = text(params.get("source")).toLowerCase();
  const statusFilter = text(params.get("status")).toLowerCase();
  const search = text(params.get("search")).toLowerCase();
  const from = text(params.get("from"));
  const to = text(params.get("to"));
  const fromTime = from ? new Date(from).getTime() : null;
  const toTime = to ? new Date(to).getTime() : null;
  const fetchLimit = Math.min(5_000, offset + limit + 100);

  try {
    const [workspaces, workerRuns, aiArkRuns, webhookEvents, storedAudit] = await Promise.all([
      getJson(url, key, "rr_workspaces?select=id,name,slug,logo_url"),
      getJson(url, key, `rr_sync_runs?select=*&source=neq.ai_ark&order=started_at.desc&limit=${fetchLimit}`),
      getJson(url, key, `rr_sync_runs?select=*&source=eq.ai_ark&order=started_at.desc&limit=${fetchLimit}`),
      getJson(url, key, `rr_webhook_events?select=*&order=received_at.desc&limit=${fetchLimit}`),
      getJson(url, key, `rr_audit_log?select=*&order=created_at.desc&limit=${fetchLimit}`),
    ]);
    const workspaceById = new Map(workspaces.map((row) => [text(row.id), text(row.name) || text(row.slug)]));
    const workspaceLogoById = new Map(workspaces.map((row) => [text(row.id), text(row.logo_url) || null]));
    const workspaceLogoByName = new Map(workspaces.map((row) => [(text(row.name) || text(row.slug)).toLowerCase(), text(row.logo_url) || null]));
    const events: AuditEvent[] = [];
    for (const row of [...workerRuns, ...aiArkRuns]) {
      const sourceKey = text(row.source) === "ai_ark" ? "ai_ark" : "worker";
      const workspace = workspaceById.get(text(row.workspace_id)) ?? null;
      events.push({ id: `sync:${text(row.id)}`, timestamp: text(row.started_at), source: sourceKey === "ai_ark" ? "AI Ark" : "Background worker", sourceKey, action: text(row.run_type) || text(row.source) || "sync", status: text(row.status) || "unknown", severity: statusSeverity(row.status), workspace, workspaceLogo: workspaceLogoById.get(text(row.workspace_id)) ?? null, summary: syncSummary(row, workspace), details: row });
    }
    for (const row of webhookEvents) {
      const workspace = workspaceById.get(text(row.workspace_id)) ?? null;
      events.push({ id: `webhook:${text(row.id)}`, timestamp: text(row.received_at), source: "HeyReach webhook", sourceKey: "heyreach", action: text(row.event_type) || "webhook event", status: text(row.status) || "unknown", severity: statusSeverity(row.status), workspace, workspaceLogo: workspaceLogoById.get(text(row.workspace_id)) ?? null, summary: webhookSummary(row, workspace), details: { ...row, raw: "[payload stored in rr_webhook_events]" } });
    }
    for (const row of storedAudit) {
      const details = object(row.details);
      const actorType = text(row.actor_type) || text(details.source) || text(details.actor) || "reply_radar";
      const sourceKey = actorType.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const status = text(details.status) || "recorded";
      const eventType = text(row.event_type) || text(details.action) || "audit";
      const workspace = text(details.workspaceName) || workspaceById.get(text(row.workspace_id)) || workspaceById.get(text(details.workspaceId)) || null;
      const workspaceId = text(row.workspace_id) || text(details.workspaceId);
      events.push({ id: `audit:${text(row.id)}`, timestamp: text(row.created_at), source: actorType, sourceKey, action: eventType, status, severity: statusSeverity(status), workspace, workspaceLogo: workspaceLogoById.get(workspaceId) ?? workspaceLogoByName.get((workspace ?? "").toLowerCase()) ?? null, summary: text(details.summary) || `${actorType} recorded ${eventType.replaceAll(".", " ")}.`, details: { ...details, entityType: row.actor_type, entityId: row.actor_id } });
    }
    const filtered = events
      .filter((event) => !sourceFilter || event.sourceKey === sourceFilter)
      .filter((event) => !statusFilter || event.severity === statusFilter || event.status.toLowerCase() === statusFilter)
      .filter((event) => !search || [event.source, event.action, event.status, event.workspace, event.summary].some((value) => text(value).toLowerCase().includes(search)))
      .filter((event) => fromTime === null || new Date(event.timestamp).getTime() >= fromTime)
      .filter((event) => toTime === null || new Date(event.timestamp).getTime() <= toTime)
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const page = filtered.slice(offset, offset + limit);
    return NextResponse.json({ ok: true, events: page, hasMore: filtered.length > offset + limit, nextOffset: offset + page.length, generatedAt: new Date().toISOString(), filters: { sources: ["worker", "heyreach", "ai_ark", "supabase", "anthropic", "admin", "user"], statuses: ["success", "info", "warning", "error"] } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Audit feed failed." }, { status: 502 });
  }
}
