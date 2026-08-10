import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";

type Row = Record<string, unknown>;
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

async function db(url: string, key: string, path: string, options: RequestInit = {}) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...(options.headers ?? {}) },
    cache: "no-store",
  });
  const body = await response.text();
  let data: unknown = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  if (!response.ok) throw new Error(`Supabase ${path.split("?")[0]} ${response.status}`);
  return data;
}

/**
 * Batch refresh conversations older than 24h since last refresh.
 * Processes one workspace at a time, max 20 conversations per workspace per run.
 */
export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Not configured" }, { status: 503 });

  // Verify cron secret if configured
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = new URL(request.url).searchParams.get("secret") ??
      request.headers.get("authorization")?.replace("Bearer ", "");
    if (auth !== cronSecret) return NextResponse.json({ ok: false }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const batchSize = 20;

  // Get all workspaces with HeyReach API keys
  const workspaces = (await db(url, key,
    "rr_workspaces?select=id,slug,heyreach_api_key_ciphertext&heyreach_api_key_ciphertext=neq.&order=name.asc",
  )) as Row[];

  let totalRefreshed = 0;
  let totalErrors = 0;
  const workspaceResults: { slug: string; refreshed: number; errors: number }[] = [];

  for (const workspace of workspaces) {
    const apiKey = text(workspace.heyreach_api_key_ciphertext);
    if (!apiKey) continue;

    // Get conversations needing refresh: last_refreshed_at is null or older than 24h
    const conversations = (await db(url, key,
      `rr_conversations?select=id&workspace_id=eq.${encodeURIComponent(text(workspace.id))}&or=(last_refreshed_at.is.null,last_refreshed_at.lt.${encodeURIComponent(cutoff)})&order=last_refreshed_at.asc.nullsfirst&limit=${batchSize}`,
    )) as Row[];

    if (!conversations.length) continue;

    const ids = conversations.map((c) => text(c.id)).filter(Boolean);
    let refreshed = 0;
    let errors = 0;

    // Refresh one at a time to avoid overwhelming HeyReach
    for (const convId of ids) {
      try {
        const refreshResponse = await fetch(`${new URL(request.url).origin}/api/conversations/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId: convId }),
        });
        const result = await refreshResponse.json().catch(() => ({}));
        if (result.ok && result.refreshed > 0) {
          refreshed++;
        } else {
          errors++;
        }
      } catch {
        errors++;
      }
      // Small delay between conversations to be gentle on APIs
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    totalRefreshed += refreshed;
    totalErrors += errors;
    workspaceResults.push({ slug: text(workspace.slug), refreshed, errors });
    console.log(`[cron-refresh] ${workspace.slug}: ${refreshed} refreshed, ${errors} errors`);
  }

  void writeAuditEvent({ url, key }, {
    actor: "Cron",
    action: "conversations.batch_refreshed",
    entityType: "system",
    details: {
      source: "cron",
      status: totalErrors > 0 ? "partial" : "success",
      totalRefreshed,
      totalErrors,
      workspaces: workspaceResults.length,
      summary: `Batch refresh: ${totalRefreshed} conversations refreshed across ${workspaceResults.length} workspace${workspaceResults.length === 1 ? "" : "s"}.`,
    },
  });

  return NextResponse.json({ ok: true, totalRefreshed, totalErrors, workspaces: workspaceResults });
}
