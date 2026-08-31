import { NextResponse } from "next/server";
export const maxDuration = 30;
export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY!;
  const tryModel = async (model: string) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 30, messages: [{ role: "user", content: "hi" }] }) });
    const b = await r.json().catch(() => ({}));
    return { model, status: r.status, ok: r.ok, error: (b as Record<string,unknown>)?.error ?? null };
  };
  return NextResponse.json({
    opus5: await tryModel("claude-opus-5"),
    opus48: await tryModel("claude-opus-4-8"),
    sonnet45: await tryModel("claude-sonnet-4-5"),
  });
}
