type SupabaseConfig = { url: string; key: string };
type Row = Record<string, unknown>;

const object = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : {};

export async function classifyLatestReply(
  config: SupabaseConfig,
  conversationId: string,
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

  const provider = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest",
      max_tokens: 10,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: `Classify the lead's latest inbound reply as exactly one word: positive, neutral, or negative.\n\n${rows
            .map((row) => `${row.direction}: ${String(row.body ?? "")}`)
            .join("\n")}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!provider.ok) return;
  const payload = await provider.json().catch(() => ({}));
  const sentiment = String(
    payload?.content?.find((item: { type?: string }) => item.type === "text")?.text ?? "",
  )
    .trim()
    .toLowerCase();
  if (!["positive", "neutral", "negative"].includes(sentiment)) return;
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
          },
        },
      }),
      cache: "no-store",
    },
  );
}
