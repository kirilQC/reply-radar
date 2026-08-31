import { NextResponse } from "next/server";
export const maxDuration = 60;
export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY!;
  const call = async (model: string, maxTok: number) => {
    const started = Date.now();
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: maxTok, messages: [{ role: "user", content: "Write a warm 3-sentence LinkedIn reply to a prospect who said they're traveling and want to skip a meeting. Be brief." }] }) });
    const b = await r.json().catch(() => ({}));
    return { status: r.status, ms: Date.now() - started, ok: r.ok, errType: (b as any)?.error?.type ?? null, errMsg: ((b as any)?.error?.message ?? "").slice(0,120) };
  };
  // burst of 12 concurrent opus-5 draft-sized calls
  const burst = await Promise.all(Array.from({ length: 12 }, () => call("claude-opus-5", 500)));
  const summary = { ok: burst.filter(b => b.ok).length, failed: burst.filter(b => !b.ok).length, statuses: burst.map(b => b.status), errTypes: Array.from(new Set(burst.map(b=>b.errType).filter(Boolean))), sampleErr: burst.find(b=>!b.ok) ?? null };
  return NextResponse.json({ single: await call("claude-opus-5", 500), burst12: summary });
}
