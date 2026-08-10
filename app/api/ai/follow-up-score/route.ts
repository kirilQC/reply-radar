import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!url || !key || !apiKey) return NextResponse.json({ ok: false, error: "Not configured" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const thread = Array.isArray(body.thread) ? body.thread : [];
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const workspaceName = typeof body.workspaceName === "string" ? body.workspaceName : "";
  const leadName = typeof body.leadName === "string" ? body.leadName : "";
  const followUpPrompt = typeof body.followUpPrompt === "string" && body.followUpPrompt ? body.followUpPrompt : "";
  const sentiment = typeof body.sentiment === "string" ? body.sentiment : "";
  if (!thread.length) return NextResponse.json({ ok: true, urgency: 0, reason: null });

  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };
  const force = body.force === true;

  // Cache lives on the latest inbound message — a new reply creates a fresh row, so
  // the score naturally regenerates when the conversation moves forward.
  const latest = conversationId
    ? await fetch(
        `${url}/rest/v1/rr_messages?select=id,raw_data&conversation_id=eq.${encodeURIComponent(conversationId)}&direction=eq.inbound&order=sent_at.desc&limit=1`,
        { headers, cache: "no-store" },
      ).then((r) => (r.ok ? r.json() : [])).catch(() => [])
    : [];
  const latestId = latest?.[0]?.id;
  const latestRaw = latest?.[0]?.raw_data && typeof latest[0].raw_data === "object" ? latest[0].raw_data : {};
  const latestRadar = latestRaw.reply_radar && typeof latestRaw.reply_radar === "object" ? latestRaw.reply_radar : {};
  if (!force && latestRadar.followup_analyzed_at && latestRadar.followup_urgency !== undefined) {
    return NextResponse.json({
      ok: true,
      cached: true,
      urgency: Number(latestRadar.followup_urgency) || 0,
      reason: String(latestRadar.followup_reason ?? ""),
    });
  }

  const systemPrompt = followUpPrompt
    ? `You are a follow-up urgency scorer for sales conversations. Score urgency 0-100 based on the client's criteria.\n\nClient follow-up criteria:\n${followUpPrompt}\n\nReturn ONLY valid JSON: { "urgency": <0-100>, "reason": "<one sentence>" }. If no follow-up is needed, return urgency 0 with a reason.`
    : `You are a follow-up urgency scorer for LinkedIn sales conversations. Analyze the conversation and score how urgently we need to follow up (0-100). Consider: time since last message, sentiment (${sentiment || "unknown"}), whether the lead asked a question, whether they expressed interest, whether they went silent after agreeing to something. Return ONLY valid JSON: { "urgency": <0-100>, "reason": "<one sentence>" }. If no follow-up is needed, return urgency 0.`;

  const threadText = thread.map((item: { direction?: string; body?: string; sentAt?: string }) =>
    `[${item.sentAt ?? ""}] ${item.direction ?? "message"}: ${item.body ?? ""}`
  ).join("\n");

  const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
  const model = process.env.ANTHROPIC_MODEL || FALLBACK_MODEL;
  const t0 = Date.now();

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 100, temperature: 0, system: systemPrompt, messages: [{ role: "user", content: threadText }] }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  const durationMs = Date.now() - t0;
  const payload = aiRes?.ok ? await aiRes.json().catch(() => ({})) : {};
  const text = payload?.content?.find((item: { type?: string }) => item.type === "text")?.text ?? "";
  const inputTokens = payload?.usage?.input_tokens ?? 0;
  const outputTokens = payload?.usage?.output_tokens ?? 0;

  let urgency = 0;
  let reason = "";
  try {
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    urgency = Math.max(0, Math.min(100, Number(parsed.urgency) || 0));
    reason = String(parsed.reason ?? "");
  } catch {
    urgency = 0;
    reason = "";
  }

  if (aiRes?.ok && latestId) {
    await fetch(`${url}/rest/v1/rr_messages?id=eq.${encodeURIComponent(latestId)}`, {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        raw_data: {
          ...latestRaw,
          reply_radar: { ...latestRadar, followup_urgency: urgency, followup_reason: reason, followup_analyzed_at: new Date().toISOString() },
        },
      }),
    }).catch(() => null);
  }

  void writeAuditEvent({ url, key }, {
    actor: "anthropic", action: "followup.scored", entityType: "conversation", entityId: conversationId,
    details: { source: "anthropic", status: aiRes?.ok ? "success" : "failed", model, inputTokens, outputTokens, durationMs, workspaceId, workspaceName, leadName, followUpUrgency: urgency, summary: `Follow-up scored ${leadName || "lead"} at ${urgency}/100: ${reason}` },
  });

  return NextResponse.json({ ok: true, cached: false, urgency, reason });
}
