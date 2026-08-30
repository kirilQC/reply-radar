// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Pull a single lead's current LinkedIn conversation from HeyReach on demand (the per-conversation refresh
// button), upserting any new messages into our tables.
import { NextResponse } from "next/server";
import { refreshLeadConversation } from "../../../lib/cold-calling";

export const maxDuration = 60;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug ?? "");
  const leadId = String(body.leadId ?? "");
  if (!slug || !leadId) return NextResponse.json({ ok: false, error: "slug and leadId required" }, { status: 400 });
  const result = await refreshLeadConversation(slug, leadId);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
