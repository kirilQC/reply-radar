import { NextRequest, NextResponse } from "next/server";
import { writeAuditEvent } from "../../lib/audit-log";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body?.preferences) {
    return NextResponse.json({ error: "preferences are required" }, { status: 400 });
  }
  const response = NextResponse.json({ ok: true, scope: body.scope || "general" });
  // The cookie gives the general inbox a durable device/browser fallback even
  // when the user is not signed into a teammate profile.
  response.cookies.set("reply-radar-preferences", JSON.stringify(body.preferences), {
    httpOnly: false,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365 * 2,
    path: "/",
  });
  await writeAuditEvent({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }, { actor: "Dashboard user", action: "appearance.saved", entityType: "preferences", entityId: String(body.scope || "general"), details: { source: "user", status: "success", summary: `Dashboard appearance and layout preferences were saved for ${body.scope || "the general dashboard"}.` } });
  return response;
}
