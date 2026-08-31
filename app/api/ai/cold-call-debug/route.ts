import { NextResponse } from "next/server";
export const maxDuration = 60;
export async function GET() {
  const key = process.env.ANTHROPIC_API_KEY!;
  const call = async (label: string, extra: Record<string, unknown>) => {
    const started = Date.now();
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-opus-5", max_tokens: 500, messages: [{ role: "user", content: "Return ONLY JSON with fields draft, reason, sentiment. Conversation:\noutbound: hi\ninbound: not interested" }], ...extra }) });
    const b = await r.json().catch(() => ({}));
    return { label, status: r.status, ms: Date.now() - started, ok: r.ok, errType: (b as any)?.error?.type ?? null, errMsg: ((b as any)?.error?.message ?? "").slice(0,200) };
  };
  return NextResponse.json({
    temp0: await call("temp0", { temperature: 0 }),
    temp1: await call("temp1", { temperature: 1 }),
    withSystem: await call("withSystem", { temperature: 0, system: "You are a helpful sales assistant." }),
    noTemp: await call("noTemp", {}),
  });
}
