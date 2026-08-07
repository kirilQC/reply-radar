import { NextRequest, NextResponse } from "next/server";

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
  return response;
}
