// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { resolveModel } from "../../../../shared/anthropic-model.mjs";
import { writeAuditEvent } from "../../../lib/audit-log";
import { clientContext, withClientContext } from "../../../lib/client-context";
import { defaultIcpPrompt } from "../../../lib/scoring-templates";

type Row = Record<string, unknown>;
const object = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};

// An Anthropic scoring call can run past the 15s default; give it room so scoring is not killed mid-call.
export const maxDuration = 60;

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!url || !key || !apiKey) return NextResponse.json({ ok: false, error: "Not configured" }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  const leadId = typeof body.leadId === "string" ? body.leadId : "";
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const workspaceName = typeof body.workspaceName === "string" ? body.workspaceName : "";
  const leadName = typeof body.leadName === "string" ? body.leadName : "";
  // A client with no ICP prompt of their own is scored on general seniority rather than on a rubric
  // invented here. The panel that edits this is locked until the client brief is written, so the
  // unconfigured case is the normal case early on and needs to already be doing something sensible.
  const icpPrompt = typeof body.icpPrompt === "string" && body.icpPrompt.trim() ? body.icpPrompt : defaultIcpPrompt();
  // The ICP criteria say which titles and industries to reward; the brief says what the client
  // actually sells. Without it a prompt like "score higher when their remit includes the problem the
  // client solves" has no problem to reason about, so the score would be seniority guesswork.
  //
  // Still accepted from the body, because the browser already has the brief on screen and passing it
  // saves a read — but no longer depended on. A caller that omits it gets the stored brief instead of
  // silently scoring against nothing.
  const passedBrief = typeof body.clientBrief === "string" ? body.clientBrief.trim() : "";
  if (!leadId) return NextResponse.json({ ok: false, error: "leadId required" }, { status: 400 });

  const headers = { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" };

  // Fetch lead data
  const leadRes = await fetch(`${url}/rest/v1/rr_leads?select=*&id=eq.${encodeURIComponent(leadId)}&limit=1`, { headers, cache: "no-store" });
  if (!leadRes.ok) return NextResponse.json({ ok: false, error: "Lead not found" }, { status: 404 });
  const leads = (await leadRes.json()) as Row[];
  const lead = leads[0];
  if (!lead) return NextResponse.json({ ok: false, error: "Lead not found" }, { status: 404 });

  // Check if already scored
  const rawData = object(lead.raw_data);
  const rr = object(rawData.reply_radar);
  if (rr.icp_score !== undefined && rr.icp_score !== null) {
    return NextResponse.json({ ok: true, cached: true, icpScore: Number(rr.icp_score), icpReason: String(rr.icp_reason ?? "") });
  }

  // Build lead context for ICP scoring
  const enrichment = object(rr.ai_ark);
  const company = object(enrichment.company);
  const leadContext = [
    `Name: ${lead.name ?? "Unknown"}`,
    lead.title ? `Title: ${lead.title}` : null,
    lead.company ? `Company: ${lead.company}` : null,
    enrichment.headline ? `Headline: ${enrichment.headline}` : null,
    enrichment.industry ? `Industry: ${enrichment.industry}` : null,
    enrichment.location ? `Location: ${JSON.stringify(enrichment.location)}` : null,
    company.name ? `Company details: ${company.name}${company.industry ? ` (${company.industry})` : ""}${company.employeeCount ? `, ${company.employeeCount} employees` : ""}` : null,
  ].filter(Boolean).join("\n");

  const briefSection = passedBrief
    ? `\n\nAbout the client you are scoring for — read this first, every judgement below depends on it:\n${passedBrief}`
    : "";
  const systemPrompt = withClientContext(
    `You are an ICP (Ideal Customer Profile) scoring assistant. Score this lead from 0-100 based on how well they match the client's ICP.${briefSection}\n\nClient ICP criteria:\n${icpPrompt}\n\nReturn ONLY valid JSON with two fields: score (integer 0-100) and reason (one sentence explaining the score).`,
    passedBrief ? "" : await clientContext(workspaceId),
  );

  const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
  const model = resolveModel(process.env.ANTHROPIC_MODEL || FALLBACK_MODEL);
  const t0 = Date.now();

  const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 100, temperature: 0, system: systemPrompt, messages: [{ role: "user", content: leadContext }] }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  const durationMs = Date.now() - t0;
  const payload = aiRes?.ok ? await aiRes.json().catch(() => ({})) : {};
  const text = payload?.content?.find((item: { type?: string }) => item.type === "text")?.text ?? "";
  const inputTokens = payload?.usage?.input_tokens ?? 0;
  const outputTokens = payload?.usage?.output_tokens ?? 0;

  let icpScore = 0;
  let icpReason = "";
  try {
    const parsed = JSON.parse(text.replace(/^```json\s*|\s*```$/g, ""));
    icpScore = Math.max(0, Math.min(100, Number(parsed.score) || 0));
    icpReason = String(parsed.reason ?? "");
  } catch {
    icpScore = 0;
    icpReason = "Could not parse ICP score.";
  }

  // Save permanently to lead's raw_data
  await fetch(`${url}/rest/v1/rr_leads?id=eq.${encodeURIComponent(leadId)}`, {
    method: "PATCH",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({ raw_data: { ...rawData, reply_radar: { ...rr, icp_score: icpScore, icp_reason: icpReason, icp_scored_at: new Date().toISOString() } } }),
  }).catch(() => null);

  // Audit
  void writeAuditEvent({ url, key }, {
    actor: "anthropic", action: "icp.scored", entityType: "lead", entityId: leadId,
    details: { source: "anthropic", status: aiRes?.ok ? "success" : "failed", model, inputTokens, outputTokens, durationMs, workspaceId, workspaceName, leadName, icpScore, summary: `ICP scored ${leadName || "lead"} at ${icpScore}/100: ${icpReason}` },
  });

  return NextResponse.json({ ok: true, cached: false, icpScore, icpReason });
}
