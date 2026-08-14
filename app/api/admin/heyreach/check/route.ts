// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return NextResponse.json({ ok: false, error: "API key is required." }, { status: 400 });
  const base = process.env.HEYREACH_API_BASE ?? "https://api.heyreach.io/api/public/";
  try {
    const response = await fetch(`${base.replace(/\/$/, "")}/auth/CheckApiKey`, {
      headers: { "X-API-KEY": apiKey },
      cache: "no-store",
    });
    return NextResponse.json({ ok: response.ok, status: response.status, message: response.ok ? "HeyReach API key is valid." : "HeyReach rejected this API key." }, { status: response.ok ? 200 : 401 });
  } catch {
    return NextResponse.json({ ok: false, error: "Unable to reach HeyReach from the server." }, { status: 502 });
  }
}
