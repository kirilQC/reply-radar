// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { writeAuditEvent } from "../../../lib/audit-log";
import { clientContext, withClientContext } from "../../../lib/client-context";
import { latestInboundMessage, mergeMessageRadar } from "../../../lib/message-radar";

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

export type PastReplyContext = {
  body: string;
  senderName: string;
  leadName: string;
  campaignName: string;
};

async function fetchPastReplies(workspaceId: string, campaignName: string | undefined): Promise<PastReplyContext[]> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !workspaceId) return [];
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const resolvedId = await resolveWorkspaceId(workspaceId, url, headers);

  // Get all conversations for this workspace + the lead attached to each — the
  // lead name gets attached to each past reply so the admin feed can label who
  // the example was sent to.
  const convResponse = await fetch(
    `${url}/rest/v1/rr_conversations?select=id,lead_id&workspace_id=eq.${encodeURIComponent(resolvedId)}&limit=200`,
    { headers, cache: "no-store" },
  );
  if (!convResponse.ok) return [];
  const conversations = (await convResponse.json().catch(() => [])) as Row[];
  const convIds = conversations.map((c) => String(c.id)).filter(Boolean);
  if (!convIds.length) return [];
  const leadIdByConv = new Map(conversations.map((c) => [String(c.id), String(c.lead_id ?? "")]));

  // Fetch recent outbound messages across all this client's conversations
  const msgResponse = await fetch(
    `${url}/rest/v1/rr_messages?select=body,raw_data,conversation_id&conversation_id=in.(${convIds.join(",")})&direction=eq.outbound&order=sent_at.desc&limit=80`,
    { headers, cache: "no-store" },
  );
  if (!msgResponse.ok) return [];
  const messages = (await msgResponse.json().catch(() => [])) as Row[];

  // Resolve lead names in a single batched request keyed on the conversations
  // above, so each past reply carries the recipient it was actually sent to.
  const uniqueLeadIds = [...new Set([...leadIdByConv.values()].filter(Boolean))];
  const leadNameById = new Map<string, string>();
  if (uniqueLeadIds.length) {
    const leadResponse = await fetch(
      `${url}/rest/v1/rr_leads?select=id,name&id=in.(${uniqueLeadIds.join(",")})`,
      { headers, cache: "no-store" },
    ).catch(() => null);
    if (leadResponse?.ok) {
      const rows = (await leadResponse.json().catch(() => [])) as Row[];
      for (const row of rows) leadNameById.set(String(row.id), String(row.name ?? ""));
    }
  }

  // Separate by campaign: same campaign vs. other campaigns
  const sameCampaign: PastReplyContext[] = [];
  const otherCampaign: PastReplyContext[] = [];

  for (const msg of messages) {
    const body = String(msg.body ?? "").trim();
    if (!body || body.length < 15) continue; // skip trivial messages
    const radar = object(object(msg.raw_data).reply_radar);
    const msgCampaign = String(object(radar.campaign).name ?? "");
    const senderName = String(object(radar.sender).name ?? "");
    const leadName = leadNameById.get(leadIdByConv.get(String(msg.conversation_id)) ?? "") ?? "";
    const context: PastReplyContext = { body, senderName, leadName, campaignName: msgCampaign };
    if (campaignName && msgCampaign === campaignName) {
      sameCampaign.push(context);
    } else {
      otherCampaign.push(context);
    }
  }

  // Build the final set: prioritize same-campaign replies
  const result: PastReplyContext[] = [];
  for (const reply of sameCampaign.slice(0, 10)) {
    if (result.length >= 10) break;
    result.push(reply);
  }
  if (result.length < 10) {
    for (const reply of otherCampaign) {
      if (result.length >= 10) break;
      result.push(reply);
    }
  }
  return result;
}

/** Fetch the lead's role + company for audit-log enrichment (best-effort). */
async function fetchLeadHeadline(conversationId: string | undefined): Promise<{ leadTitle: string; leadCompany: string }> {
  const empty = { leadTitle: "", leadCompany: "" };
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !conversationId) return empty;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  try {
    const convResp = await fetch(
      `${url}/rest/v1/rr_conversations?select=lead_id&id=eq.${encodeURIComponent(conversationId)}&limit=1`,
      { headers, cache: "no-store" },
    );
    if (!convResp.ok) return empty;
    const [conv] = (await convResp.json().catch(() => [])) as Row[];
    const leadId = String(conv?.lead_id ?? "");
    if (!leadId) return empty;
    const leadResp = await fetch(
      `${url}/rest/v1/rr_leads?select=role,company&id=eq.${encodeURIComponent(leadId)}&limit=1`,
      { headers, cache: "no-store" },
    );
    if (!leadResp.ok) return empty;
    const [lead] = (await leadResp.json().catch(() => [])) as Row[];
    return {
      leadTitle: String(lead?.role ?? ""),
      leadCompany: String(lead?.company ?? ""),
    };
  } catch {
    return empty;
  }
}

/** Hard ceiling for the flag explanation. Two lines in the strip above the thread, and no more. */
const REASON_MAX = 150;

function clampReason(value: unknown) {
  const reason = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!reason) return "";
  // First sentence only. The trailing lookahead keeps "8 a.m." and "Inc." from ending the sentence.
  const firstSentence = reason.match(/^.*?[.!?](?=\s+[A-Z]|$)/)?.[0] ?? reason;
  const trimmed = firstSentence.trim();
  if (trimmed.length <= REASON_MAX) return trimmed;
  const cut = trimmed.slice(0, REASON_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > REASON_MAX * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[,;:.\s]+$/, "")}…`;
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
  let pastReplies: PastReplyContext[] = [];
  if (mode === "analyze" && workspaceId) {
    pastReplies = await fetchPastReplies(workspaceId, campaignName).catch(() => []);
  }

  // Build the tone context from past replies
  const toneContext = pastReplies.length
    ? `\n\nHere are recent outbound replies from this client's team. Use these as a reference for tone, style, and typical response patterns. Mirror the voice, length, and approach you see in these examples:\n\n${pastReplies.map((r, i) => `Example ${i + 1}: ${r.body}`).join("\n\n")}\n\n`
    : "";

  // Latest inbound message = what the assistant is trying to answer. Grabbed
  // from the tail of the thread the caller sent, so we don't burn another read.
  const inboundMessage = [...thread].reverse().find((item: { direction?: string; body?: string }) => String(item.direction ?? "").toLowerCase() === "inbound");
  const inboundBody = inboundMessage ? String(inboundMessage.body ?? "") : "";
  const conversationIdParam = typeof body.conversationId === "string" ? body.conversationId : "";
  const { leadTitle, leadCompany } = mode === "analyze" ? await fetchLeadHeadline(conversationIdParam) : { leadTitle: "", leadCompany: "" };

  // The client's brief goes in front of whatever prompt the caller supplied, and stands on its own if
  // none was. Writing in somebody's name with no idea who they are is the whole reason this is loaded
  // here rather than trusted to arrive in the body.
  const briefed = withClientContext(body.system ? String(body.system) : "", await clientContext(workspaceId));
  const systemPrompt = briefed || undefined;

  /**
   * A regenerate is a request for a different answer, and it was not getting one.
   *
   * Temperature was pinned at 0, so asking twice about an unchanged conversation returned the same
   * draft — pressing the button looked broken. The reason line *did* appear to change, which is the
   * tell: it is generated after the draft in the JSON, and temperature-0 inference is not bit-exact,
   * so what drift there is shows up later in the sequence. The draft, coming first, was the most
   * stable thing in the response.
   *
   * The automatic first pass stays at 0 — it is cached against the reply and should be stable. Only an
   * explicit regenerate loosens up, and it is told out loud that it is rewriting, because a warmer
   * temperature alone tends to reword rather than rethink.
   */
  const regenerate = body.regenerate === true;
  const regenerateNudge = regenerate
    ? "\n\nThis is a REGENERATE: a draft for this conversation was already produced and the user rejected it. Write a genuinely different reply — a different opening, a different structure, a different way into the same goal. Do not lightly reword the obvious answer.\n"
    : "";

  const reasonInstruction = "reason (ONE sentence, 20 words maximum, saying why this latest inbound reply deserves attention — no preamble, no restating the message, no second sentence)";

  /**
   * A draft is a starting point, not an outgoing message — and it was quietly inventing the parts
   * it could not know. It offered a lead two specific meeting slots ("Monday, 8/16: 2pm ET or
   * Tuesday, 8/17: 10am ET") that came from nowhere: no calendar, no availability, nothing in the
   * thread. Read quickly, that is a draft you send and then have to walk back.
   *
   * So anything only the human sender can supply — times, prices, dates, links, names, headcounts,
   * commitments — is left as a bracketed blank they fill in. Fewer words on screen than a
   * confident guess, and the guess is the expensive one.
   */
  const noFabricationRule =
    "\n\nNever invent facts. Do not state availability, dates, times, prices, deadlines, numbers, links, documents, names or commitments unless they appear explicitly in the conversation above or in the client context. Where the reply needs a detail only the sender can supply, leave a short bracketed placeholder in its place — for example \"I'm free (insert time here)\", \"pricing starts at (insert price here)\", \"here's the (insert link here)\" — and write the rest of the sentence around it normally. Placeholders are expected and preferred over a plausible guess. Never fill a placeholder with an example value.\n";

  const userContent = `${mode === "analyze" ? `Return ONLY valid JSON with three string fields: draft (a concise, professional reply the sender could use), ${reasonInstruction}, and sentiment (exactly positive, neutral, or negative). Do not use markdown. ` : ""}${noFabricationRule}${regenerateNudge}${toneContext}${instruction}\n\nConversation:\n${thread.map((item: { direction?: string; body?: string }) => `${item.direction ?? "message"}: ${item.body ?? ""}`).join("\n")}`;

  const requestBody = (m: string) => JSON.stringify({
    model: m,
    max_tokens: body.maxTokens ?? 500,
    temperature: body.temperature ?? (regenerate ? 1 : 0),
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
      // Enforced here rather than left to the prompt, because this line sits above the thread in a
      // fixed strip and a model that decides to write three sentences pushes the conversation itself
      // off screen. Cut at the first sentence, then hard-trim on a word boundary if that one sentence
      // is still a paragraph.
      analysis.reason = clampReason(analysis.reason);
    }
    if (response.ok && mode === "analyze" && typeof body.conversationId === "string" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const store = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
      const latest = await latestInboundMessage(store, body.conversationId);
      if (latest) {
        const parsed = String(analysis.sentiment ?? "").toLowerCase();
        const sentimentValue = ["positive", "neutral", "negative"].includes(parsed) ? parsed : latest.radar.sentiment;
        await mergeMessageRadar(store, latest.id, {
          sentiment: sentimentValue,
          cached_draft: String(analysis.draft ?? ""),
          cached_reason: String(analysis.reason ?? ""),
          analyzed_at: new Date().toISOString(),
        });
      }
    }
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "anthropic", action: response.ok ? (mode === "analyze" ? "conversation.analyzed" : "draft.generated") : "draft.failed", entityType: "conversation", entityId: typeof body.conversationId === "string" ? body.conversationId : undefined, details: { source: "anthropic", status: response.ok ? "success" : "failed", model, inputTokens: payload?.usage?.input_tokens ?? 0, outputTokens: payload?.usage?.output_tokens ?? 0, durationMs, sentiment: mode === "analyze" ? String(analysis.sentiment ?? "").toLowerCase() : undefined, workspaceId: body.workspaceId, workspaceName: body.workspaceName, leadName: typeof body.leadName === "string" ? body.leadName : undefined, pastRepliesUsed: pastReplies.length,
      // Full texts persisted so the admin drafting feed can show what the model saw
      // and produced without doing a second lookup. Truncated to keep the row light.
      // Legacy flat form kept for older audit readers.
      pastReplies: pastReplies.map((r) => r.body.slice(0, 400)),
      // Richer form the admin draft feed reads: each example carries the
      // sender, recipient and campaign so reviewers can trace the voice source.
      pastReplyContext: pastReplies.map((r) => ({
        body: r.body.slice(0, 400),
        senderName: r.senderName,
        leadName: r.leadName,
        campaignName: r.campaignName,
      })),
      draft: mode === "analyze" ? String(analysis.draft ?? "").slice(0, 1000) : text.slice(0, 1000),
      reason: mode === "analyze" ? String(analysis.reason ?? "").slice(0, 400) : undefined,
      inboundMessage: inboundBody.slice(0, 1000),
      campaignName: campaignName ?? "",
      leadTitle,
      leadCompany,
      summary: response.ok ? `Anthropic generated a reply draft with ${model} using ${pastReplies.length} past replies as tone reference.` : `Anthropic could not generate a reply draft with ${model}.` } });
    const providerMessage = typeof payload?.error?.message === "string" ? payload.error.message : "Anthropic rejected the draft request.";
    return NextResponse.json({ ok: response.ok, ...(response.ok ? {} : { error: providerMessage }), draft: mode === "analyze" ? String(analysis.draft ?? "") : text, reason: mode === "analyze" ? String(analysis.reason ?? "") : undefined, sentiment: mode === "analyze" ? String(analysis.sentiment ?? "") : undefined, usage: payload?.usage ?? null }, { status: response.ok ? 200 : response.status });
  } catch {
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "anthropic", action: "draft.failed", entityType: "conversation", details: { source: "anthropic", status: "failed", model, summary: "Reply Radar could not reach Anthropic to generate the requested draft." } });
    return NextResponse.json({ ok: false, error: "Unable to reach Anthropic from the server." }, { status: 502 });
  }
}
