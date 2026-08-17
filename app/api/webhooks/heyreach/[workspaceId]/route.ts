// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { after, NextResponse } from "next/server";
import { ingestHeyReachWebhook } from "../../../../lib/heyreach-ingestion";
import { isHeyReachValidationPayload } from "../../../../lib/heyreach-conversation";
import { classifyLatestReply } from "../../../../lib/reply-sentiment";

const ready = (workspaceId: string) => NextResponse.json({ ok: true, webhook: "ready", workspace: workspaceId });
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export async function GET(_request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await context.params;
  return workspaceId ? ready(workspaceId) : NextResponse.json({ ok: false }, { status: 400 });
}

export async function HEAD(_request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await context.params;
  return new Response(null, { status: workspaceId ? 200 : 400, headers: { "content-type": "application/json" } });
}

// Compatibility endpoint for HeyReach webhook URLs configured without a secret
// segment (…/api/webhooks/heyreach/{workspace}). The secret-bearing route remains
// available for installations that use signed URLs.
export async function POST(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await context.params;
  if (!workspaceId) return NextResponse.json({ ok: false }, { status: 400 });
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") return ready(workspaceId);
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  try {
    const lookupColumn = isUuid(workspaceId) ? "id" : "slug";
    const lookup = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext&${lookupColumn}=eq.${encodeURIComponent(workspaceId)}&limit=1`, { headers, cache: "no-store" });
    if (!lookup.ok) return NextResponse.json({ ok: false, stage: "workspace_lookup", error: (await lookup.text()).slice(0, 1_000) }, { status: 502 });
    const rows = await lookup.json() as Array<{ id: string; name?: string | null; slug?: string | null; heyreach_api_key_ciphertext?: string | null }>;
    const workspace = rows[0];
    if (!workspace) return NextResponse.json({ ok: false, error: "Workspace not found." }, { status: 404 });
    if (isHeyReachValidationPayload(payload as Record<string, unknown>)) {
      console.info("heyreach_webhook_validated", { workspaceId, workspace: workspace.id });
      return NextResponse.json({ ok: true, validation: true, workspace: workspaceId, history: "skipped_for_synthetic_test" }, { status: 200 });
    }
    /*
     * The worker's nightly reconciliation pass posts here too, marked so it can be told apart.
     *
     * It goes through this route rather than reimplementing ingestion because ingestion is where the
     * block list, the outbound-only rule, campaign attribution, enrichment and the identity rollup all
     * live — a second copy of that in the worker would drift, and the rules it would drift away from
     * are the ones deciding who ends up in the inbox. The marker only suppresses the webhook clock;
     * everything else about a reconciled conversation is stored identically.
     */
    const origin = String((payload as Record<string, unknown>).reply_radar_source ?? "") === "reconciliation" ? "reconciliation" : "webhook";
    const result = await ingestHeyReachWebhook({ url, key }, workspace, payload as Record<string, unknown>, origin);
    // Discarded ingests never wrote a conversation row, so there is nothing to classify.
    if (!("discarded" in result) && result.conversationId) {
      after(() => classifyLatestReply({ url, key }, result.conversationId, workspace.slug ?? workspaceId, { workspaceName: workspace.name ?? undefined }).catch(() => undefined));
    }
    console.info("heyreach_webhook_processed", { workspaceId, origin, ...result });
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) { return NextResponse.json({ ok: false, stage: "unexpected", error: error instanceof Error ? error.message : "Webhook processing failed" }, { status: 502 }); }
}
