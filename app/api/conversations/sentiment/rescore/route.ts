import { NextResponse } from "next/server";
import { classifyLatestReply } from "../../../../lib/reply-sentiment";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * Re-runs the classifier on one conversation, ignoring the sentiment already stored.
 *
 * The normal path never does this: a scored reply keeps its verdict so the same message is not paid
 * for twice. That is right until the classification rules themselves change, at which point every
 * older verdict is stale and nothing in the system would ever revisit it. This is the way back.
 */
export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ ok: false, error: "No Anthropic key is configured, so nothing can be scored." }, { status: 503 });
  }

  const body = await request.json().catch(() => ({}));
  const conversationId = text((body as Record<string, unknown>).conversationId);
  if (!UUID.test(conversationId)) return NextResponse.json({ ok: false, error: "conversationId required" }, { status: 400 });

  try {
    const sentiment = await classifyLatestReply({ url, key }, conversationId, text((body as Record<string, unknown>).workspaceId) || undefined, {
      workspaceName: text((body as Record<string, unknown>).workspaceName) || undefined,
      leadName: text((body as Record<string, unknown>).leadName) || undefined,
      force: true,
    });
    // classifyLatestReply returns nothing when it found no inbound message or the model answered with
    // something that is not a label; either way there is no new verdict to hand back.
    if (!sentiment) return NextResponse.json({ ok: false, error: "The classifier did not return a verdict. Try again shortly." }, { status: 502 });
    return NextResponse.json({ ok: true, sentiment });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Could not re-score this reply." },
      { status: 502 },
    );
  }
}
