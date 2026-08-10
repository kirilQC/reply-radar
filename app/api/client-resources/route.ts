import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../lib/audit-log";

type Json = Record<string, unknown>;
const config = () => ({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
const headers = (key: string) => ({ apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" });
const cleanTemplates = (value: unknown) =>
  (Array.isArray(value) ? value : []).slice(0, 100).map((item) => {
    const row = item && typeof item === "object" ? item as Json : {};
    return { id: String(row.id ?? crypto.randomUUID()).slice(0, 80), name: String(row.name ?? "").trim().slice(0, 100), value: String(row.value ?? "").trim().slice(0, 10_000) };
  }).filter((item) => item.name && item.value);

async function workspace(slug: string) {
  const { url, key } = config();
  if (!url || !key) throw new Error("Supabase is not configured.");
  const response = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,client_brief,anthropic_model,custom_system_prompt,guardrails&slug=eq.${encodeURIComponent(slug)}&limit=1`, { headers: headers(key), cache: "no-store" });
  const rows = await response.json().catch(() => []);
  if (!response.ok) throw new Error(`Supabase returned ${response.status}.`);
  return { row: Array.isArray(rows) ? rows[0] as Json | undefined : undefined, url, key };
}

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("workspace")?.trim() ?? "";
  if (!slug) return NextResponse.json({ ok: false, error: "workspace is required" }, { status: 400 });
  try {
    const { row } = await workspace(slug);
    if (!row) return NextResponse.json({ ok: false, error: "Workspace not found." }, { status: 404 });
    const guardrails = row.guardrails && typeof row.guardrails === "object" ? row.guardrails as Json : {};
    return NextResponse.json({ ok: true, workspace: { id: row.id, name: row.name, slug: row.slug, brief: row.client_brief ?? "", model: row.anthropic_model ?? "", systemPrompt: row.custom_system_prompt ?? "", messagingDocUrl: guardrails.messaging_doc_url ?? "", icpPrompt: guardrails.icp_prompt ?? "", followUpPrompt: guardrails.follow_up_prompt ?? "", followUpThreshold: Number(guardrails.follow_up_threshold ?? 50), quickTemplates: cleanTemplates(guardrails.quick_templates) } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Resources unavailable." }, { status: 502 });
  }
}

export async function PUT(request: Request) {
  const body = await request.json().catch(() => ({})) as Json;
  const slug = String(body.workspace ?? "").trim();
  if (!slug) return NextResponse.json({ ok: false, error: "workspace is required" }, { status: 400 });
  try {
    const { row, url, key } = await workspace(slug);
    if (!row) return NextResponse.json({ ok: false, error: "Workspace not found." }, { status: 404 });
    const guardrails = row.guardrails && typeof row.guardrails === "object" ? row.guardrails as Json : {};
    const next = {
      ...guardrails,
      ...(Object.hasOwn(body, "messagingDocUrl") ? { messaging_doc_url: String(body.messagingDocUrl ?? "").trim().slice(0, 2_000) } : {}),
      ...(Object.hasOwn(body, "quickTemplates") ? { quick_templates: cleanTemplates(body.quickTemplates) } : {}),
    };
    const response = await fetch(`${url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(String(row.id))}`, { method: "PATCH", headers: { ...headers(key), Prefer: "return=minimal" }, body: JSON.stringify({ guardrails: next }) });
    if (!response.ok) throw new Error(`Supabase returned ${response.status}.`);
    await writeAuditEvent({ url, key }, { actor: "Admin", action: "workspace.resources.updated", entityType: "workspace", entityId: String(row.id), details: { source: "dashboard", status: "success", workspaceId: row.id, workspaceName: row.name, summary: `Reply Radar synchronized the messaging document and ${cleanTemplates(next.quick_templates).length} quick template${cleanTemplates(next.quick_templates).length === 1 ? "" : "s"} for ${row.name}.` } });
    return NextResponse.json({ ok: true, messagingDocUrl: next.messaging_doc_url ?? "", quickTemplates: cleanTemplates(next.quick_templates) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Resources could not be saved." }, { status: 502 });
  }
}
