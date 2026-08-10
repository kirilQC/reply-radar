import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });
  const thread = Array.isArray(body.thread) ? body.thread : [];
  const instruction = typeof body.instruction === "string" ? body.instruction : "";
  const mode = body.mode === "analyze" ? "analyze" : "draft";
  const DEFAULT_MODEL = "claude-haiku-4-5-latest";
  const DEPRECATED = new Set(["claude-3-5-haiku-latest", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307", "claude-3-5-sonnet-latest", "claude-3-5-sonnet-20241022"]);
  const requestedModel = typeof body.model === "string" && body.model ? body.model : process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const model = DEPRECATED.has(requestedModel) ? DEFAULT_MODEL : requestedModel;
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: body.maxTokens ?? 500, temperature: body.temperature ?? 0, ...(body.system ? { system: body.system } : {}), messages: [{ role: "user", content: `${mode === "analyze" ? "Return ONLY valid JSON with three string fields: draft (a concise, professional reply the sender could use), reason (one plain-English sentence explaining why this latest inbound reply deserves attention), and sentiment (exactly positive, neutral, or negative). Do not use markdown. " : ""}${instruction}\n\nConversation:\n${thread.map((item: { direction?: string; body?: string }) => `${item.direction ?? "message"}: ${item.body ?? ""}`).join("\n")}` }] }),
    });
    const payload = await response.json().catch(() => ({}));
    const text = payload?.content?.find((item: { type?: string }) => item.type === "text")?.text ?? "";
    let analysis: { draft?: string; reason?: string; sentiment?: string } = {};
    if (mode === "analyze") {
      try { analysis = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")); } catch { analysis = { draft: text, reason: "This lead sent a new reply that is ready for review." }; }
    }
    if (response.ok && mode === "analyze" && typeof body.conversationId === "string" && ["positive", "neutral", "negative"].includes(String(analysis.sentiment).toLowerCase()) && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const headers = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "content-type": "application/json" };
      const latest = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rr_messages?select=id,raw_data&conversation_id=eq.${encodeURIComponent(body.conversationId)}&direction=eq.inbound&order=sent_at.desc&limit=1`, { headers, cache: "no-store" }).then((result) => result.ok ? result.json() : []).catch(() => []);
      if (latest?.[0]?.id) {
        const raw = latest[0].raw_data && typeof latest[0].raw_data === "object" ? latest[0].raw_data : {};
        const radar = raw.reply_radar && typeof raw.reply_radar === "object" ? raw.reply_radar : {};
        await fetch(`${process.env.SUPABASE_URL}/rest/v1/rr_messages?id=eq.${encodeURIComponent(latest[0].id)}`, { method: "PATCH", headers: { ...headers, Prefer: "return=minimal" }, body: JSON.stringify({ raw_data: { ...raw, reply_radar: { ...radar, sentiment: String(analysis.sentiment).toLowerCase(), analyzed_at: new Date().toISOString() } } }) }).catch(() => null);
      }
    }
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "Anthropic", action: response.ok ? (mode === "analyze" ? "conversation.analyzed" : "draft.generated") : "draft.failed", entityType: "conversation", entityId: typeof body.conversationId === "string" ? body.conversationId : undefined, details: { source: "anthropic", status: response.ok ? "success" : "failed", model, workspaceId: body.workspaceId, workspaceName: body.workspaceName, summary: response.ok ? `Anthropic generated a reply draft and review reason with ${model}.` : `Anthropic could not generate a reply draft with ${model}.` } });
    const providerMessage = typeof payload?.error?.message === "string" ? payload.error.message : "Anthropic rejected the draft request.";
    return NextResponse.json({ ok: response.ok, ...(response.ok ? {} : { error: providerMessage }), draft: mode === "analyze" ? String(analysis.draft ?? "") : text, reason: mode === "analyze" ? String(analysis.reason ?? "") : undefined, sentiment: mode === "analyze" ? String(analysis.sentiment ?? "") : undefined, usage: payload?.usage ?? null }, { status: response.ok ? 200 : response.status });
  } catch {
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "Anthropic", action: "draft.failed", entityType: "conversation", details: { source: "anthropic", status: "failed", model, summary: "Reply Radar could not reach Anthropic to generate the requested draft." } });
    return NextResponse.json({ ok: false, error: "Unable to reach Anthropic from the server." }, { status: 502 });
  }
}
