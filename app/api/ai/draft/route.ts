import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });
  const thread = Array.isArray(body.thread) ? body.thread : [];
  const instruction = typeof body.instruction === "string" ? body.instruction : "";
  const mode = body.mode === "analyze" ? "analyze" : "draft";
  const model = typeof body.model === "string" && body.model ? body.model : process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: body.maxTokens ?? 500, temperature: body.temperature ?? 0, ...(body.system ? { system: body.system } : {}), messages: [{ role: "user", content: `${mode === "analyze" ? "Return ONLY valid JSON with two string fields: draft (a concise, professional reply the sender could use) and reason (one plain-English sentence explaining why this latest inbound reply deserves attention). Do not use markdown. " : ""}${instruction}\n\nConversation:\n${thread.map((item: { direction?: string; body?: string }) => `${item.direction ?? "message"}: ${item.body ?? ""}`).join("\n")}` }] }),
    });
    const payload = await response.json().catch(() => ({}));
    const text = payload?.content?.find((item: { type?: string }) => item.type === "text")?.text ?? "";
    let analysis: { draft?: string; reason?: string } = {};
    if (mode === "analyze") {
      try { analysis = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")); } catch { analysis = { draft: text, reason: "This lead sent a new reply that is ready for review." }; }
    }
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "Anthropic", action: response.ok ? (mode === "analyze" ? "conversation.analyzed" : "draft.generated") : "draft.failed", entityType: "conversation", entityId: typeof body.conversationId === "string" ? body.conversationId : undefined, details: { source: "anthropic", status: response.ok ? "success" : "failed", model, workspaceId: body.workspaceId, workspaceName: body.workspaceName, summary: response.ok ? `Anthropic generated a reply draft and review reason with ${model}.` : `Anthropic could not generate a reply draft with ${model}.` } });
    return NextResponse.json({ ok: response.ok, draft: mode === "analyze" ? String(analysis.draft ?? "") : text, reason: mode === "analyze" ? String(analysis.reason ?? "") : undefined, usage: payload?.usage ?? null }, { status: response.ok ? 200 : response.status });
  } catch {
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "Anthropic", action: "draft.failed", entityType: "conversation", details: { source: "anthropic", status: "failed", model, summary: "Reply Radar could not reach Anthropic to generate the requested draft." } });
    return NextResponse.json({ ok: false, error: "Unable to reach Anthropic from the server." }, { status: 502 });
  }
}
