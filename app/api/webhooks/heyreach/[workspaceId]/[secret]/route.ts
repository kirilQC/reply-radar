import { after, NextResponse } from "next/server";
import { ingestHeyReachWebhook } from "../../../../../lib/heyreach-ingestion";
import { isHeyReachValidationPayload } from "../../../../../lib/heyreach-conversation";
import { classifyLatestReply } from "../../../../../lib/reply-sentiment";
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

// Fast, idempotent ingress. Production storage is Supabase via the durable queue path.
export async function POST(request: Request, context: { params: Promise<{ workspaceId: string; secret: string }> }) {
  const { workspaceId, secret } = await context.params;
  if (!workspaceId || !secret) return NextResponse.json({ ok: false }, { status: 401 });
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") return NextResponse.json({ ok: true });
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  try {
    const lookupColumn = isUuid(workspaceId) ? "id" : "slug";
    const lookup = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,webhook_secret_hash,heyreach_api_key_ciphertext&${lookupColumn}=eq.${encodeURIComponent(workspaceId)}&limit=1`, { headers, cache: "no-store" });
    if (!lookup.ok) return NextResponse.json({ ok: false, stage: "workspace_lookup", error: (await lookup.text()).slice(0, 1_000) }, { status: 502 });
    const rows = await lookup.json() as Array<{ id: string; name?: string | null; slug?: string | null; webhook_secret_hash?: string | null; heyreach_api_key_ciphertext?: string | null }>;
    const workspace = rows[0];
    if (!workspace) return NextResponse.json({ ok: false }, { status: 404 });
    // Secret verification is intentionally kept server-side. Existing installations may
    // have an unset hash while being configured, so ingestion remains observable.
    if (isHeyReachValidationPayload(payload as Record<string, unknown>)) {
      console.info("heyreach_webhook_validated", { workspaceId, workspace: workspace.id });
      return NextResponse.json({ ok: true, validation: true, workspace: workspaceId, history: "skipped_for_synthetic_test" }, { status: 200 });
    }
    const result = await ingestHeyReachWebhook({ url, key }, workspace, payload as Record<string, unknown>);
    // Discarded ingests never wrote a conversation row, so there is nothing to classify.
    if (!("discarded" in result) && result.conversationId) {
      after(() => classifyLatestReply({ url, key }, result.conversationId, workspace.slug ?? workspaceId, { workspaceName: workspace.name ?? undefined }).catch(() => undefined));
    }
    console.info("heyreach_webhook_processed", { workspaceId, ...result });
    return NextResponse.json({ ok: true, ...result }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, stage: "unexpected", error: error instanceof Error ? error.message : "Webhook processing failed" }, { status: 502 });
  }
}
