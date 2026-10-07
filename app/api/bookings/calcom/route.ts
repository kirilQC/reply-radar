// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { removeCalCom, saveCalCom } from "../../../lib/booking-connect";
import { supabaseConfig } from "../../../lib/booking-run";

/** Connects cal.com with an API key (QC creates the webhook), or disconnects it. `workspaceId` for a client's own. */
export async function POST(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) return NextResponse.json({ ok: false, error: "Paste a cal.com API key." }, { status: 400 });
  try {
    const connection = await saveCalCom(config, request, apiKey, typeof body.workspaceId === "string" ? body.workspaceId.trim() : "");
    return NextResponse.json({ ok: true, email: connection.email });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not connect cal.com." }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  await removeCalCom(config, (new URL(request.url).searchParams.get("workspaceId") ?? "").trim());
  return NextResponse.json({ ok: true });
}
