import { NextResponse } from "next/server";
import { queryByIds } from "../../../lib/chunk-query";

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lightweight endpoint: returns current sentiment for a list of conversation IDs. */
export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false }, { status: 503 });

  const body = await request.json().catch(() => ({}));
  // Ids come straight from the browser, so only let real uuids into the filter.
  const ids: string[] = Array.isArray(body.conversationIds)
    ? [...new Set((body.conversationIds as unknown[]).map((id) => String(id)))].filter((id) => UUID.test(id)).slice(0, 500)
    : [];
  if (!ids.length) return NextResponse.json({ ok: true, sentiments: {} });

  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const messages = await queryByIds(ids, 20, async (batch) => {
    const response = await fetch(
      `${url}/rest/v1/rr_messages?select=conversation_id,raw_data,sent_at&conversation_id=in.(${batch.join(",")})&direction=eq.inbound&order=sent_at.desc`,
      { headers, cache: "no-store" },
    ).catch(() => null);
    return response?.ok ? ((await response.json().catch(() => [])) as Row[]) : [];
  });

  // For each conversation, find the latest inbound message's sentiment
  const sentiments: Record<string, string | null> = {};
  for (const msg of messages) {
    const convId = String(msg.conversation_id);
    if (sentiments[convId] !== undefined) continue; // already have latest
    const raw = msg.raw_data && typeof msg.raw_data === "object" ? msg.raw_data as Row : {};
    const rr = raw.reply_radar && typeof raw.reply_radar === "object" ? raw.reply_radar as Row : {};
    const s = String(rr.sentiment ?? "").toLowerCase();
    sentiments[convId] = ["positive", "neutral", "negative"].includes(s) ? s : null;
  }

  return NextResponse.json({ ok: true, sentiments });
}
