import { NextRequest, NextResponse } from "next/server";
import { writeAuditEvent } from "../../lib/audit-log";

type Row = Record<string, unknown>;
const safeScope = (value: unknown) =>
  String(value || "general")
    .trim()
    .slice(0, 160) || "general";
const config = () => ({
  url: process.env.SUPABASE_URL,
  key: process.env.SUPABASE_SERVICE_ROLE_KEY,
});

async function request(path: string, init: RequestInit = {}) {
  const { url, key } = config();
  if (!url || !key) return null;
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => []);
  if (!response.ok)
    throw new Error(`Preference store failed (${response.status}).`);
  return payload;
}

export async function GET(requestValue: NextRequest) {
  const scope = safeScope(requestValue.nextUrl.searchParams.get("scope"));
  try {
    const rows = (await request(
      `rr_device_preferences?select=appearance,inbox_layout&device_key=eq.${encodeURIComponent(scope)}&limit=1`,
    )) as Row[] | null;
    const row = Array.isArray(rows) ? rows[0] : null;
    return NextResponse.json({
      ok: true,
      scope,
      preferences: row
        ? { appearance: row.appearance ?? {}, layout: row.inbox_layout ?? {} }
        : null,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Preferences unavailable.",
      },
      { status: 502 },
    );
  }
}

export async function POST(requestValue: NextRequest) {
  const body = await requestValue.json().catch(() => null);
  if (!body?.preferences)
    return NextResponse.json(
      { error: "preferences are required" },
      { status: 400 },
    );
  const scope = safeScope(body.scope);
  const preferences = body.preferences as Row;
  try {
    await request("rr_device_preferences?on_conflict=device_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        device_key: scope,
        appearance: preferences.appearance ?? {},
        inbox_layout: preferences.layout ?? {},
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "Preferences could not be saved.",
      },
      { status: 502 },
    );
  }
  const response = NextResponse.json({ ok: true, scope });
  response.cookies.set("reply-radar-preferences", JSON.stringify(preferences), {
    httpOnly: false,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365 * 2,
    path: "/",
  });
  await writeAuditEvent(config(), {
    actor: "Dashboard user",
    action: Array.isArray(
      (preferences.layout as Row | undefined)?.starredLeadIds,
    )
      ? "lead.stars.saved"
      : "appearance.saved",
    entityType: "preferences",
    entityId: scope,
    details: {
      source: "user",
      status: "success",
      summary: `Dashboard preferences were saved for ${scope}.`,
    },
  });
  return response;
}
