import { NextResponse } from "next/server";
export const maxDuration = 30;
export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY;
  const envModel = process.env.ANTHROPIC_MODEL || "(unset)";
  if (!key) return NextResponse.json({ error: "no key" });
  const tryModel = async (model: string) => {
    const started = Date.now();
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 50, messages: [{ role: "user", content: "Say hello in 3 words." }] }),
    });
    const body = await r.json().catch(() => ({}));
    return { model, status: r.status, ms: Date.now() - started, ok: r.ok, error: (body as Record<string,unknown>)?.error ?? null, text: (body as Record<string,unknown>)?.content ? "ok" : null };
  };
  return NextResponse.json({
    envModel,
    haiku45: await tryModel("claude-haiku-4-5-20251001"),
  });
}
