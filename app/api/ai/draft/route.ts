// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { resolveModel, temperatureField, DEFAULT_MODEL } from "../../../../shared/anthropic-model.mjs";
import { writeAuditEvent } from "../../../lib/audit-log";
import { clientContext, withClientContext } from "../../../lib/client-context";
import { latestInboundMessage, mergeMessageRadar } from "../../../lib/message-radar";
import { stripDashes, stripDashLikeHyphens } from "../../../../shared/no-dashes.mjs";
import { bannedPhrases, humanReplies, pickExamples, voiceBlock, type VoiceExample, type VoiceMessage } from "../../../lib/reply-voice";

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

/**
 * Everything the draft needs to sound like this client's team: real past replies (see reply-voice.ts),
 * who is sending this one, the client's name, and the per-client reply instructions from Configuration
 * (`guardrails.reply_prompt`), which drafting used to ignore entirely.
 */
type Voice = { examples: VoiceExample[]; senderName: string; clientName: string; replyPrompt: string };

async function loadVoice(workspaceRef: string, campaignName: string | undefined, conversationId: string): Promise<Voice> {
  const empty: Voice = { examples: [], senderName: "", clientName: "", replyPrompt: "" };
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || !workspaceRef) return empty;
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const get = async (path: string): Promise<Row[]> => {
    const response = await fetch(`${url}/rest/v1/${path}`, { headers, cache: "no-store" }).catch(() => null);
    if (!response?.ok) return [];
    const rows = await response.json().catch(() => []);
    return Array.isArray(rows) ? (rows as Row[]) : [];
  };
  const workspaceId = await resolveWorkspaceId(workspaceRef, url, headers);
  const [workspaceRows, conversations] = await Promise.all([
    get(`rr_workspaces?select=name,reply_prompt:guardrails->>reply_prompt&id=eq.${encodeURIComponent(workspaceId)}&limit=1`),
    // The 300 most recently active threads: enough history to find a dozen real replies for most clients.
    get(`rr_conversations?select=id,lead_id&workspace_id=eq.${encodeURIComponent(workspaceId)}&order=last_message_at.desc.nullslast,id.asc&limit=300`),
  ]);
  const ids = [...new Set([...conversations.map((c) => String(c.id)), conversationId].filter(Boolean))];
  const leadIdByConversation = new Map(conversations.map((c) => [String(c.id), String(c.lead_id ?? "")]));
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 40) batches.push(ids.slice(i, i + 40));
  const leadIds = [...new Set([...leadIdByConversation.values()].filter(Boolean))];
  const leadBatches: string[][] = [];
  for (let i = 0; i < leadIds.length; i += 100) leadBatches.push(leadIds.slice(i, i + 100));
  const [messageRows, leadRows] = await Promise.all([
    Promise.all(batches.map((batch) => get(
      `rr_messages?select=conversation_id,direction,body,sent_at,sender:raw_data->reply_radar->sender->>name,campaign:raw_data->reply_radar->campaign->>name&conversation_id=in.(${batch.join(",")})&order=sent_at.asc&limit=1000`,
    ))).then((pages) => pages.flat()),
    Promise.all(leadBatches.map((batch) => get(`rr_leads?select=id,name&id=in.(${batch.join(",")})`))).then((pages) => pages.flat()),
  ]);
  const leadNameById = new Map(leadRows.map((row) => [String(row.id), String(row.name ?? "")]));
  const leadNames = new Map([...leadIdByConversation].map(([conversation, lead]) => [conversation, leadNameById.get(lead) ?? ""]));
  const messages: VoiceMessage[] = messageRows.map((row) => ({
    conversationId: String(row.conversation_id ?? ""),
    direction: String(row.direction ?? ""),
    body: String(row.body ?? ""),
    sentAt: String(row.sent_at ?? ""),
    senderName: String(row.sender ?? ""),
    campaignName: String(row.campaign ?? ""),
  }));
  // Whoever last wrote to this lead from our side is who the draft is written as.
  const senderName = [...messages].reverse().find((m) => m.conversationId === conversationId && m.direction === "outbound" && m.senderName)?.senderName ?? "";
  const examples = pickExamples(humanReplies(messages, leadNames, conversationId), { campaignName, senderName, limit: 12 });
  return {
    examples,
    senderName,
    clientName: String(workspaceRows[0]?.name ?? ""),
    replyPrompt: String(workspaceRows[0]?.reply_prompt ?? "").trim(),
  };
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

// An Anthropic draft call routinely runs past the 15s platform default; give it room (Vercel Pro allows up
// to 300s). Without this the worker's per-reply drafting was being killed and retried.
export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });
  const thread = Array.isArray(body.thread) ? body.thread : [];
  const instruction = typeof body.instruction === "string" ? body.instruction : "";
  const mode = body.mode === "analyze" ? "analyze" : "draft";
  const FALLBACK_MODEL = DEFAULT_MODEL;
  const requestedModel = resolveModel(typeof body.model === "string" && body.model ? body.model : process.env.ANTHROPIC_MODEL || FALLBACK_MODEL);
  let model = requestedModel;

  // How this client's team really replies (reply-voice.ts), plus the per-client reply instructions.
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
  const campaignName = typeof body.campaignName === "string" ? body.campaignName : undefined;
  const voice: Voice = workspaceId
    ? await loadVoice(workspaceId, campaignName, typeof body.conversationId === "string" ? body.conversationId : "").catch(() => ({ examples: [], senderName: "", clientName: "", replyPrompt: "" }))
    : { examples: [], senderName: "", clientName: "", replyPrompt: "" };
  const pastReplies = voice.examples;
  const clientName = voice.clientName || (typeof body.workspaceName === "string" ? body.workspaceName : "") || "this client";
  const voiceSection = voiceBlock(pastReplies, clientName, voice.senderName);
  const avoid = bannedPhrases(pastReplies);

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
  // The voice goes last in the system prompt, after the background, so it is the freshest thing the
  // model reads about how to write. The client's own reply instructions sit with it.
  const systemPrompt = [
    briefed,
    voiceSection,
    voice.replyPrompt ? `Reply instructions for ${clientName} (follow these):\n${voice.replyPrompt}` : "",
  ].filter(Boolean).join("\n\n") || undefined;
  // Callers also pass the brief as "Client context: …", which the system prompt above already carries.
  // Sent twice it doubled the prompt and drowned out the examples, so only a real instruction is kept.
  const extraInstruction = /^client context:/i.test(instruction.trim()) ? "" : instruction;

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
    ? "\n\nThis is a REGENERATE: a draft for this conversation was already produced and the user rejected it. Write a genuinely different reply: a different opening, a different structure, a different way into the same goal. Do not lightly reword the obvious answer.\n"
    : "";

  const reasonInstruction = "reason (ONE sentence, 20 words maximum, saying why this latest inbound reply deserves attention; no preamble, no restating the message, no second sentence)";

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
    "\n\nNever invent facts. Do not state availability, dates, times, prices, deadlines, numbers, links, documents, names or commitments unless they appear explicitly in the conversation above or in the client context. Where the reply needs a detail only the sender can supply, leave a short bracketed placeholder in its place, for example \"I'm free (insert time here)\", \"pricing starts at (insert price here)\", \"here's the (insert link here)\", and write the rest of the sentence around it normally. Placeholders are expected and preferred over a plausible guess. Never fill a placeholder with an example value.\n";

  /**
   * The writing rules. The old line asked for "a concise, professional reply", which is precisely the
   * register that reads as AI: polished, complete, slightly formal. The team writes like people
   * answering a LinkedIn message, so that is what is asked for, with the examples as the authority.
   */
  const writingRules = [
    pastReplies.length
      ? "Write the reply the way the examples in HOW WE REPLY are written. They outrank anything else here on tone and length."
      : "Write like a person answering a LinkedIn message: short, plain, friendly, specific. Not like marketing copy.",
    "Answer what the lead actually said first. If they asked something, answer it directly before anything else.",
    "Do not re-pitch or repeat the opening message. Only explain the product if they asked what it is, and then in a sentence or two.",
    "At most one ask or next step.",
    "Plain words and short sentences. No buzzwords, no flattery, no filler openers.",
    avoid.length ? `Never use these phrases: ${avoid.map((p) => `"${p}"`).join(", ")}.` : "",
    "Punctuation: never use em dashes, en dashes, or a hyphen as a dash between clauses. Use a comma or a full stop instead.",
  ].filter(Boolean).map((line) => `- ${line}`).join("\n");
  const speaker = (item: { direction?: string }) =>
    String(item.direction ?? "").toLowerCase() === "outbound" ? (voice.senderName ? `Us (${voice.senderName})` : "Us") : String(item.direction ?? "").toLowerCase() === "inbound" ? "Lead" : "Message";
  const userContent = `${mode === "analyze" ? `Return ONLY valid JSON with three string fields: draft (the next message we would send this lead, in our voice), ${reasonInstruction}, and sentiment (exactly positive, neutral, or negative). Do not use markdown. ` : ""}\n\nHow to write the draft:\n${writingRules}${noFabricationRule}${regenerateNudge}${extraInstruction ? `\n${extraInstruction}\n` : ""}\n\nConversation:\n${thread.map((item: { direction?: string; body?: string }) => `${speaker(item)}: ${item.body ?? ""}`).join("\n")}`;

  const requestBody = (m: string) => JSON.stringify({
    model: m,
    // 500 cut drafts off mid-sentence ("Would a short call be useful? I'"). A short reply never needs
    // this much, so the ceiling only matters when something goes long, and then it must not truncate.
    max_tokens: body.maxTokens ?? 1200,
    // The Claude 5 family / Opus 4.8 reject `temperature` — omit it for those, keep it for older models.
    ...temperatureField(m, body.temperature ?? (regenerate ? 1 : 0)),
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
    let payload = await response.json().catch(() => ({}));
    // A draft cut off by the token limit is never shown as if it were whole. One retry with double room.
    if (response.ok && payload?.stop_reason === "max_tokens") {
      const retry = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: anthropicHeaders,
        body: JSON.stringify({ ...JSON.parse(requestBody(model)), max_tokens: 2400 }),
      });
      if (retry.ok) { response = retry; payload = await retry.json().catch(() => ({})); }
    }
    const durationMs = Date.now() - t0;
    console.log(`[ai-draft] model=${model} status=${response.status} pastReplies=${pastReplies.length}`);
    const text = stripDashes(String(payload?.content?.find((item: { type?: string }) => item.type === "text")?.text ?? ""));
    let analysis: { draft?: string; reason?: string; sentiment?: string } = {};
    if (mode === "analyze") {
      try { analysis = JSON.parse(text.replace(/^```json\s*|\s*```$/g, "")); } catch { analysis = { draft: text, reason: "This lead sent a new reply that is ready for review." }; }
      // Enforced here rather than left to the prompt, because this line sits above the thread in a
      // fixed strip and a model that decides to write three sentences pushes the conversation itself
      // off screen. Cut at the first sentence, then hard-trim on a word boundary if that one sentence
      // is still a paragraph.
      analysis.reason = clampReason(analysis.reason);
      // A draft is written as a person: hyphens used as dashes go too, not just em and en dashes.
      if (typeof analysis.draft === "string") analysis.draft = stripDashLikeHyphens(analysis.draft);
    }
    if (response.ok && mode === "analyze" && typeof body.conversationId === "string" && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const store = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
      const latest = await latestInboundMessage(store, body.conversationId);
      if (latest) {
        // The dedicated classifier owns sentiment. The draft model's guess is a side effect of writing a
        // reply and only fills the gap when nothing classified this message yet; overwriting a stored
        // value let a looser read flip a lead's sentiment every time a draft was generated.
        const parsed = String(analysis.sentiment ?? "").toLowerCase();
        const storedSentiment = typeof latest.radar.sentiment === "string" ? latest.radar.sentiment.trim() : "";
        const draftSentiment = ["positive", "neutral", "negative"].includes(parsed) ? parsed : "";
        await mergeMessageRadar(store, latest.id, {
          ...(!storedSentiment && draftSentiment ? { sentiment: draftSentiment } : {}),
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
        inbound: r.inbound.slice(0, 300),
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
      httpStatus: response.status,
      providerError: response.ok ? undefined : (typeof payload?.error?.message === "string" ? payload.error.message.slice(0, 300) : `HTTP ${response.status}`),
      summary: response.ok ? `Anthropic generated a reply draft with ${model} using ${pastReplies.length} real past replies as the voice reference.` : `Anthropic could not generate a reply draft with ${model} (HTTP ${response.status}${typeof payload?.error?.message === "string" ? `: ${payload.error.message.slice(0, 160)}` : ""}).` } });
    const providerMessage = typeof payload?.error?.message === "string" ? payload.error.message : "Anthropic rejected the draft request.";
    return NextResponse.json({ ok: response.ok, ...(response.ok ? {} : { error: providerMessage }), draft: mode === "analyze" ? String(analysis.draft ?? "") : text, reason: mode === "analyze" ? String(analysis.reason ?? "") : undefined, sentiment: mode === "analyze" ? String(analysis.sentiment ?? "") : undefined, usage: payload?.usage ?? null }, { status: response.ok ? 200 : response.status });
  } catch {
    await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "anthropic", action: "draft.failed", entityType: "conversation", details: { source: "anthropic", status: "failed", model, summary: "QC Command could not reach Anthropic to generate the requested draft." } });
    return NextResponse.json({ ok: false, error: "Unable to reach Anthropic from the server." }, { status: 502 });
  }
}
