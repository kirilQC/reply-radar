// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";
import { briefedSystemPrompt } from "../../../lib/client-context";
import { latestInboundMessage, mergeMessageRadar } from "../../../lib/message-radar";
import { defaultFollowUpPrompt } from "../../../lib/scoring-templates";

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
  // With no criteria of their own a client is scored on who owes whom a reply — the one rubric that
  // cannot produce a nag, and therefore the only one safe to apply to a client nobody has configured.
  const followUpPrompt = typeof body.followUpPrompt === "string" && body.followUpPrompt.trim() ? body.followUpPrompt : defaultFollowUpPrompt();
  const sentiment = typeof body.sentiment === "string" ? body.sentiment : "";
  if (!thread.length) return NextResponse.json({ ok: true, urgency: 0, reason: null });

  const force = body.force === true;

  // Cache lives on the latest inbound message — a new reply creates a fresh row, so
  // the score naturally regenerates when the conversation moves forward.
  const latest = await latestInboundMessage({ url, key }, conversationId);
  if (!force && latest?.radar.followup_analyzed_at && latest.radar.followup_urgency !== undefined) {
    return NextResponse.json({
      ok: true,
      cached: true,
      urgency: Number(latest.radar.followup_urgency) || 0,
      reason: String(latest.radar.followup_reason ?? ""),
    });
  }

  // Urgency is not a property of the words in the thread — it depends on whether this lead is someone
  // the client wants. "Send me pricing" from a target account and from a student are the same sentence
  // and different scores, and only the brief knows which is which.
  const systemPrompt = await briefedSystemPrompt(
    `You are a follow-up urgency scorer for LinkedIn sales conversations. Score urgency 0-100 based on the client's criteria.${sentiment ? `\n\nThe lead's latest reply reads as ${sentiment}.` : ""}\n\nClient follow-up criteria:\n${followUpPrompt}\n\nReturn ONLY valid JSON: { "urgency": <0-100>, "reason": "<one sentence>" }. If no follow-up is needed, return urgency 0 with a reason.`,
    workspaceId,
  );

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

  let persisted = false;
  if (aiRes?.ok && latest) {
    persisted = await mergeMessageRadar({ url, key }, latest.id, {
      followup_urgency: urgency,
      followup_reason: reason,
      followup_analyzed_at: new Date().toISOString(),
    });
  }

  void writeAuditEvent({ url, key }, {
    actor: "anthropic", action: "followup.scored", entityType: "conversation", entityId: conversationId,
    details: { source: "anthropic", status: aiRes?.ok ? "success" : "failed", model, inputTokens, outputTokens, durationMs, workspaceId, workspaceName, leadName, followUpUrgency: urgency, summary: `Follow-up scored ${leadName || "lead"} at ${urgency}/100: ${reason}` },
  });

  // persisted=false means the client must not treat this as cached, or the score would
  // look saved while the database has nothing and it silently recomputes on every load.
  return NextResponse.json({ ok: true, cached: false, persisted, urgency, reason });
}
