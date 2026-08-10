import { writeAuditEvent } from "./audit-log";

type SupabaseConfig = { url: string; key: string };
type Row = Record<string, unknown>;

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};

const DEFAULT_SENTIMENT_PROMPT = `You are analyzing LinkedIn sales conversations for a growth agency. Your job is to classify the lead's LATEST inbound reply based on the full conversation context.

Classification rules:

POSITIVE — The lead is showing genuine interest or engagement. Examples:
- Agrees to a meeting, call, or demo ("Sure, let's set up a time")
- Asks specific questions about the product, service, or offering
- Shares contact information (email, phone, calendar link)
- Expresses enthusiasm or curiosity ("That sounds interesting", "Tell me more")
- Refers to a colleague or says they'll loop someone in
- Confirms attendance or follow-up ("See you Monday", "I'll review and get back to you")
- Responds substantively to a prior question or proposal

NEUTRAL — The lead is not clearly interested but also not rejecting. Examples:
- Polite but non-committal ("Thanks for reaching out")
- Asks who we are or what we do without deeper engagement
- Says "not right now" but doesn't close the door ("Maybe in a few months")
- Auto-replies or out-of-office messages
- Short ambiguous replies ("Ok", "Got it", "Thanks")
- Asks to be contacted later without specifying when
- Replies that are just social pleasantries

NEGATIVE — The lead is clearly not interested or wants to disengage. Examples:
- Explicitly declines ("Not interested", "No thanks")
- Asks to be removed or stop receiving messages ("Please stop", "Unsubscribe me")
- Expresses annoyance or frustration ("Stop spamming me")
- Says they already have a solution and aren't looking to switch
- Reports the message as spam
- Hostile or rude responses
- "Wrong person" with no redirect

Important: Focus on the LATEST inbound message, but use the full conversation for context. A lead who previously seemed interested but now says "not a good time" is neutral, not negative.

Reply with exactly one word: positive, neutral, or negative.`;

async function getConfiguredPrompt(config: SupabaseConfig, workspaceId?: string): Promise<string> {
  try {
    // Try workspace's custom_system_prompt first
    if (workspaceId) {
      const response = await fetch(
        `${config.url}/rest/v1/rr_workspaces?select=custom_system_prompt&slug=eq.${encodeURIComponent(workspaceId)}&limit=1`,
        { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` }, cache: "no-store" },
      );
      if (response.ok) {
        const rows = await response.json().catch(() => []);
        if (Array.isArray(rows) && rows.length && rows[0].custom_system_prompt) {
          // Workspace has a custom prompt — prepend the sentiment classification rules
          return `${DEFAULT_SENTIMENT_PROMPT}\n\nAdditional client-specific context:\n${String(rows[0].custom_system_prompt)}`;
        }
      }
    }
  } catch { /* use default */ }
  return DEFAULT_SENTIMENT_PROMPT;
}

export async function classifyLatestReply(
  config: SupabaseConfig,
  conversationId: string,
  workspaceId?: string,
  meta?: { leadName?: string; workspaceName?: string },
) {
  if (!process.env.ANTHROPIC_API_KEY || !conversationId) {
    console.log(`[sentiment] Skipping: API key present=${!!process.env.ANTHROPIC_API_KEY}, conversationId=${conversationId}`);
    return;
  }
  const headers = {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "content-type": "application/json",
  };
  const response = await fetch(
    `${config.url}/rest/v1/rr_messages?select=id,direction,body,sent_at,raw_data&conversation_id=eq.${encodeURIComponent(conversationId)}&order=sent_at.desc&limit=20`,
    { headers, cache: "no-store" },
  );
  if (!response.ok) { console.log(`[sentiment] Messages fetch failed: ${response.status}`); return; }
  const rows = ((await response.json()) as Row[]).reverse();
  const latestInbound = [...rows].reverse().find((row) => row.direction === "inbound");
  if (!latestInbound?.id) { console.log(`[sentiment] No inbound message found for ${conversationId}`); return; }
  const latestRaw = object(latestInbound.raw_data);
  const latestRadar = object(latestRaw.reply_radar);
  if (["positive", "neutral", "negative"].includes(String(latestRadar.sentiment).toLowerCase())) { console.log(`[sentiment] Already classified as ${latestRadar.sentiment} for ${conversationId}`); return; }

  const systemPrompt = await getConfiguredPrompt(config, workspaceId);
  const DEFAULT_MODEL = "claude-haiku-4-5-20251001";
  const DEPRECATED = new Set(["claude-3-5-haiku-latest", "claude-3-5-haiku-20241022", "claude-3-haiku-20240307"]);
  const configuredModel = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  const model = DEPRECATED.has(configuredModel) ? DEFAULT_MODEL : configuredModel;
  const userContent = rows.map((row) => `${row.direction}: ${String(row.body ?? "")}`).join("\n");
  const startTime = Date.now();

  const provider = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 10,
      temperature: 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    }),
    signal: AbortSignal.timeout(8_000),
  });

  const durationMs = Date.now() - startTime;
  const payload = provider.ok ? await provider.json().catch(() => ({})) : {};
  const inputTokens = payload?.usage?.input_tokens ?? 0;
  const outputTokens = payload?.usage?.output_tokens ?? 0;

  if (!provider.ok) {
    void writeAuditEvent(config, {
      actor: "anthropic",
      action: "sentiment_analysis",
      entityType: "conversation",
      entityId: conversationId,
      details: {
        status: "error",
        model,
        httpStatus: provider.status,
        durationMs,
        reason: "sentiment_classification",
        workspaceId: workspaceId ?? null,
        workspaceName: meta?.workspaceName ?? null,
        leadName: meta?.leadName ?? null,
      },
    });
    return;
  }

  const sentiment = String(
    payload?.content?.find((item: { type?: string }) => item.type === "text")?.text ?? "",
  )
    .trim()
    .toLowerCase();

  if (!["positive", "neutral", "negative"].includes(sentiment)) {
    void writeAuditEvent(config, {
      actor: "anthropic",
      action: "sentiment_analysis",
      entityType: "conversation",
      entityId: conversationId,
      details: {
        status: "warning",
        model,
        inputTokens,
        outputTokens,
        durationMs,
        rawOutput: sentiment,
        reason: "sentiment_classification",
        note: "Model returned unexpected value",
        workspaceId: workspaceId ?? null,
        workspaceName: meta?.workspaceName ?? null,
        leadName: meta?.leadName ?? null,
      },
    });
    return;
  }

  const patchResponse = await fetch(
    `${config.url}/rest/v1/rr_messages?id=eq.${encodeURIComponent(String(latestInbound.id))}`,
    {
      method: "PATCH",
      headers: { ...headers, Prefer: "return=minimal" },
      body: JSON.stringify({
        raw_data: {
          ...latestRaw,
          reply_radar: {
            ...latestRadar,
            sentiment,
            analyzed_at: new Date().toISOString(),
            model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
          },
        },
      }),
      cache: "no-store",
    },
  );
  console.log(`[sentiment] PATCH message ${latestInbound.id} → ${sentiment}, status=${patchResponse.status}`);

  void writeAuditEvent(config, {
    actor: "anthropic",
    action: "sentiment_analysis",
    entityType: "conversation",
    entityId: conversationId,
    details: {
      status: "success",
      model,
      sentiment,
      inputTokens,
      outputTokens,
      durationMs,
      reason: "sentiment_classification",
      workspaceId: workspaceId ?? null,
      workspaceName: meta?.workspaceName ?? null,
      leadName: meta?.leadName ?? null,
    },
  });
}

export { DEFAULT_SENTIMENT_PROMPT };
