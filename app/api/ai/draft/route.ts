import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });
  const thread = Array.isArray(body.thread) ? body.thread : [];
  const instruction = typeof body.instruction === "string" ? body.instruction : "";
  const model = typeof body.model === "string" ? body.model : process.env.ANTHROPIC_MODEL;
  if (!model) return NextResponse.json({ ok: false, error: "An Anthropic model is required." }, { status: 400 });
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: body.maxTokens ?? 300, temperature: body.temperature ?? 0, ...(body.system ? { system: body.system } : {}), messages: [{ role: "user", content: `${instruction}\n\nConversation:\n${thread.map((item: { direction?: string; body?: string }) => `${item.direction ?? "message"}: ${item.body ?? ""}`).join("\n")}` }] }),
    });
    const payload = await response.json().catch(() => ({}));
    const text = payload?.content?.find((item: { type?: string }) => item.type === "text")?.text ?? "";
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "Anthropic", action: response.ok ? "draft.generated" : "draft.failed", entityType: "conversation", entityId: typeof body.conversationId === "string" ? body.conversationId : undefined, details: { source: "anthropic", status: response.ok ? "success" : "failed", model, summary: response.ok ? `Anthropic generated a reply draft with ${model}.` : `Anthropic could not generate a reply draft with ${model}.` } });
    return NextResponse.json({ ok: response.ok, draft: text, usage: payload?.usage ?? null }, { status: response.ok ? 200 : response.status });
  } catch {
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "Anthropic", action: "draft.failed", entityType: "conversation", details: { source: "anthropic", status: "failed", model, summary: "Reply Radar could not reach Anthropic to generate the requested draft." } });
    return NextResponse.json({ ok: false, error: "Unable to reach Anthropic from the server." }, { status: 502 });
  }
}
