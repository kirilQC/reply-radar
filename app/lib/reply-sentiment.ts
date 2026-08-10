import { writeAuditEvent } from "./audit-log";

type SupabaseConfig = { url: string; key: string };
type Row = Record<string, unknown>;

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};

const DEFAULT_SENTIMENT_PROMPT = `You are a sales conversation analyst. Classify the lead's latest inbound reply based on the full conversation context.

Rules:
- "positive" = interested, asks questions about the product/service, wants to learn more, agrees to a meeting, shares contact info, or expresses enthusiasm
- "neutral" = polite but non-committal, asks generic questions, or gives an ambiguous response
- "negative" = not interested, asks to be removed, expresses annoyance, or explicitly declines

Reply with exactly one word: positive, neutral, or negative.`;

async function getConfiguredPrompt(config: SupabaseConfig, workspaceId?: string): Promise<string> {
  try {
    // Try workspace-specific prompt first
    if (workspaceId) {
      const response = await fetch(
        `${config.url}/rest/v1/rr_global_config?select=value&key=eq.sentiment_prompt_${encodeURIComponent(workspaceId)}&limit=1`,
        { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` }, cache: "no-store" },
      );
      if (response.ok) {
        const rows = await response.json().catch(() => []);
        if (Array.isArray(rows) && rows.length && rows[0].value) return String(rows[0].value);
      }
    }
    // Fall back to global prompt
    const response = await fetch(
      `${config.url}/rest/v1/rr_global_config?select=value&key=eq.sentiment_prompt&limit=1`,
      { headers: { apikey: config.key, Authorization: `Bearer ${config.key}` }, cache: "no-store" },
    );
    if (response.ok) {
      const rows = await response.json().catch(() => []);
      if (Array.isArray(rows) && rows.length && rows[0].value) return String(rows[0].value);
    }
  } catch { /* use default */ }
  return DEFAULT_SENTIMENT_PROMPT;
}

export async function classifyLatestReply(
  config: SupabaseConfig,
  conversationId: string,
  workspaceId?: string,
) {
  if (!process.env.ANTHROPIC_API_KEY || !conversationId) return;
  const headers = {
    apikey: config.key,
    Authorization: `Bearer ${config.key}`,
    "content-type": "application/json",
  };
  const response = await fetch(
    `${config.url}/rest/v1/rr_messages?select=id,direction,body,sent_at,raw_data&conversation_id=eq.${encodeURIComponent(conversationId)}&order=sent_at.desc&limit=20`,
    { headers, cache: "no-store" },
  );
  if (!response.ok) return;
  const rows = ((await response.json()) as Row[]).reverse();
  const latestInbound = [...rows].reverse().find((row) => row.direction === "inbound");
  if (!latestInbound?.id) return;
  const latestRaw = object(latestInbound.raw_data);
  const latestRadar = object(latestRaw.reply_radar);
  if (["positive", "neutral", "negative"].includes(String(latestRadar.sentiment).toLowerCase())) return;

  const systemPrompt = await getConfiguredPrompt(config, workspaceId);
  const model = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
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
      },
    });
    return;
  }

  await fetch(
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
    },
  });
}

export { DEFAULT_SENTIMENT_PROMPT };
