import { NextResponse } from "next/server";
export const maxDuration = 60;
export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY!;
  const test = async (model: string) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 20, temperature: 0, messages: [{ role: "user", content: "hi" }] }) });
    const b = await r.json().catch(() => ({}));
    return { status: r.status, tempRejected: !r.ok && ((b as any)?.error?.message || "").toLowerCase().includes("temperature") };
  };
  const models = ["claude-haiku-4-5-20251001", "claude-sonnet-4-5", "claude-sonnet-4-6", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5"];
  const out: Record<string, unknown> = {};
  for (const m of models) out[m] = await test(m);
  return NextResponse.json(out);
}
