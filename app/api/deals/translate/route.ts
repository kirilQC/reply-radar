// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Translate a conversation to English.
 *
 * Some clients' outreach is in another language — Willow's is Hebrew — and a QC operator reading the
 * thread to judge a deal needs to understand it. This sends the messages to Claude once and returns the
 * English, in order, so the drawer can show a translated view with a note that it is translated.
 */
import { NextResponse } from "next/server";

const MODEL = "claude-sonnet-4-6";

export async function POST(request: Request) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return NextResponse.json({ ok: false, error: "Translation is not configured." }, { status: 503 });

  const body = (await request.json().catch(() => ({}))) as { messages?: unknown };
  const messages = Array.isArray(body.messages) ? body.messages.map((m) => String(m ?? "")).slice(0, 60) : [];
  if (!messages.length) return NextResponse.json({ ok: true, translations: [] });

  // A numbered list in, a numbered list out — the model keeps the order and never merges two messages.
  const numbered = messages.map((m, i) => `[${i + 1}] ${m.replace(/\n/g, " ")}`).join("\n");
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        temperature: 0,
        system: "You translate outreach messages to natural English. Return ONLY a JSON array of strings, one per input message, in the same order. If a message is already English, return it unchanged. No commentary.",
        messages: [{ role: "user", content: `Translate each message to English:\n\n${numbered}` }],
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as { content?: { text?: string }[] };
    const text = payload.content?.[0]?.text ?? "[]";
    const match = text.match(/\[[\s\S]*\]/);
    const translations = match ? (JSON.parse(match[0]) as unknown[]).map((t) => String(t ?? "")) : messages;
    return NextResponse.json({ ok: true, translations });
  } catch {
    return NextResponse.json({ ok: false, error: "Could not translate." }, { status: 502 });
  }
}
