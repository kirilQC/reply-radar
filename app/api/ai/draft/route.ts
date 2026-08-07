import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ ok: false, error: "ANTHROPIC_API_KEY is not configured." }, { status: 503 });
  const thread = Array.isArray(body.thread) ? body.thread : [];
  const instruction = typeof body.instruction === "string" ? body.instruction : "Draft the next concise follow-up message.";
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514", max_tokens: 300, temperature: 0.35, system: "You write concise, human B2B follow-ups. Return only the message text.", messages: [{ role: "user", content: `${instruction}\n\nConversation:\n${thread.map((item: { direction?: string; body?: string }) => `${item.direction ?? "message"}: ${item.body ?? ""}`).join("\n")}` }] }),
    });
    const payload = await response.json().catch(() => ({}));
    const text = payload?.content?.find((item: { type?: string }) => item.type === "text")?.text ?? "";
    return NextResponse.json({ ok: response.ok, draft: text, usage: payload?.usage ?? null }, { status: response.ok ? 200 : response.status });
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to reach Anthropic from the server." }, { status: 502 });
  }
}
