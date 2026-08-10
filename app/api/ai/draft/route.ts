import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";

type Row = Record<string, unknown>;
const object = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};

/** Fetch past outbound replies for the same client to use as tone examples. */
async function resolveWorkspaceId(slug: string, url: string, headers: Record<string, string>): Promise<string> {
  // If it looks like a UUID, return as-is
  if (/^[0-9a-f]{8}-/.test(slug)) return slug;
  const response = await fetch(`${url}/rest/v1/rr_workspaces?select=id&slug=eq.${encodeURIComponent(slug)}&limit=1`, { headers, cache: "no-store" });
  if (!response.ok) return slug;
  const rows = (await response.json().catch(() => [])) as Row[];
  return rows[0]?.id ? String(rows[0].id) : slug;
}

async function fetchPastReplies(workspaceId: string, campaignName: string | undefined): Promise<string[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !workspaceId) return [];
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const resolvedId = await resolveWorkspaceId(workspaceId, url, headers);

  // Get all conversations for this workspace
  const convResponse = await fetch(
    `${url}/rest/v1/rr_conversations?select=id&workspace_id=eq.${encodeURIComponent(resolvedId)}&limit=200`,
    { headers, cache: "no-store" },
  );
  if (!convResponse.ok) return [];
  const conversations = (await convResponse.json().catch(() => [])) as Row[];
  const convIds = conversations.map((c) => String(c.id)).filter(Boolean);
  if (!convIds.length) return [];

  // Fetch recent outbound messages across all this client's conversations
  const msgResponse = await fetch(
    `${url}/rest/v1/rr_messages?select=body,raw_data,conversation_id&conversation_id=in.(${convIds.join(",")})&direction=eq.outbound&order=sent_at.desc&limit=80`,
    { headers, cache: "no-store" },
  );
  if (!msgResponse.ok) return [];
  const messages = (await msgResponse.json().catch(() => [])) as Row[];

  // Separate by campaign: same campaign vs. other campaigns
  const sameCampaign: string[] = [];
  const otherCampaign: string[] = [];

  for (const msg of messages) {
    const body = String(msg.body ?? "").trim();
    if (!body || body.length < 15) continue; // skip trivial messages
    const radar = object(object(msg.raw_data).reply_radar);
    const msgCampaign = String(object(radar.campaign).name ?? "");
    if (campaignName && msgCampaign === campaignName) {
      sameCampaign.push(body);
    } else {
      otherCampaign.push(body);
    }
  }

  // Build the final set: prioritize same-campaign replies
  const result: string[] = [];

  // Add up to 10 from same campaign first
  for (const reply of sameCampaign.slice(0, 10)) {
    if (result.length >= 10) break;
    result.push(reply);
  }

  // Fill remaining slots with other-campaign replies (light reference)
  if (result.length < 10) {
    for (const reply of otherCampaign) {
      if (result.length >= 10) break;
      result.push(reply);
    }
  }

  return result;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });
  const thread = Array.isArray(body.thread) ? body.thread : [];
  const instruction = typeof body.instruction === "string" ? body.instruction : "";
  const mode = body.mode === "analyze" ? "analyze" : "draft";
  const FALLBACK_MODEL = "claude-haiku-4-5-20251001";
  const requestedModel = typeof body.model === "string" && body.model ? body.model : process.env.ANTHROPIC_MODEL || FALLBACK_MODEL;
  let model = requestedModel;

  // Fetch past outbound replies for tone learning (same client only)
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const campaignName = typeof body.campaignName === "string" ? body.campaignName : undefined;
  let pastReplies: string[] = [];
  if (mode === "analyze" && workspaceId) {
    pastReplies = await fetchPastReplies(workspaceId, campaignName).catch(() => []);
  }

  // Build the tone context from past replies
  const toneContext = pastReplies.length
    ? `\n\nHere are recent outbound replies from this client's team. Use these as a reference for tone, style, and typical response patterns. Mirror the voice, length, and approach you see in these examples:\n\n${pastReplies.map((r, i) => `Example ${i + 1}: ${r}`).join("\n\n")}\n\n`
    : "";

  const systemPrompt = body.system
    ? String(body.system)
    : undefined;

  const userContent = `${mode === "analyze" ? "Return ONLY valid JSON with three string fields: draft (a concise, professional reply the sender could use), reason (one plain-English sentence explaining why this latest inbound reply deserves attention), and sentiment (exactly positive, neutral, or negative). Do not use markdown. " : ""}${toneContext}${instruction}\n\nConversation:\n${thread.map((item: { direction?: string; body?: string }) => `${item.direction ?? "message"}: ${item.body ?? ""}`).join("\n")}`;

  const requestBody = (m: string) => JSON.stringify({
    model: m,
    max_tokens: body.maxTokens ?? 500,
    temperature: body.temperature ?? 0,
    ...(systemPrompt ? { system: systemPrompt } : {}),
    messages: [{ role: "user", content: userContent }],
  });

  const anthropicHeaders = { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" };
  try {
    const t0 = Date.now();
    let response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: anthropicHeaders, body: requestBody(model) });
    if (response.status === 404 && model !== FALLBACK_MODEL) {
      console.log(`[ai-draft] Model ${model} returned 404, retrying with ${FALLBACK_MODEL}`);
      model = FALLBACK_MODEL;
      response = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: anthropicHeaders, body: requestBody(model) });
    }
    const payload = await response.json().catch(() => ({}));
    const durationMs = Date.now() - t0;
    console.log(`[ai-draft] model=${model} status=${response.status} pastReplies=${pastReplies.length}`);
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
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "anthropic", action: response.ok ? (mode === "analyze" ? "conversation.analyzed" : "draft.generated") : "draft.failed", entityType: "conversation", entityId: typeof body.conversationId === "string" ? body.conversationId : undefined, details: { source: "anthropic", status: response.ok ? "success" : "failed", model, inputTokens: payload?.usage?.input_tokens ?? 0, outputTokens: payload?.usage?.output_tokens ?? 0, durationMs, workspaceId: body.workspaceId, workspaceName: body.workspaceName, pastRepliesUsed: pastReplies.length, summary: response.ok ? `Anthropic generated a reply draft with ${model} using ${pastReplies.length} past replies as tone reference.` : `Anthropic could not generate a reply draft with ${model}.` } });
    const providerMessage = typeof payload?.error?.message === "string" ? payload.error.message : "Anthropic rejected the draft request.";
    return NextResponse.json({ ok: response.ok, ...(response.ok ? {} : { error: providerMessage }), draft: mode === "analyze" ? String(analysis.draft ?? "") : text, reason: mode === "analyze" ? String(analysis.reason ?? "") : undefined, sentiment: mode === "analyze" ? String(analysis.sentiment ?? "") : undefined, usage: payload?.usage ?? null }, { status: response.ok ? 200 : response.status });
  } catch {
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "anthropic", action: "draft.failed", entityType: "conversation", details: { source: "anthropic", status: "failed", model, summary: "Reply Radar could not reach Anthropic to generate the requested draft." } });
    return NextResponse.json({ ok: false, error: "Unable to reach Anthropic from the server." }, { status: 502 });
  }
}
