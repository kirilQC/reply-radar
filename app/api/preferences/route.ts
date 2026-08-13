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
  const params = requestValue.nextUrl.searchParams;
  const scope = safeScope(params.get("scope"));
  // Appearance belongs to the person (identity), layout to the person AND the client they
  // are looking at (scope). `legacy` is whatever key this browser used before identities
  // existed, so a first load after the change restores rather than resets.
  const identity = params.get("identity")
    ? safeScope(params.get("identity"))
    : scope;
  const legacy = params.get("legacy") ? safeScope(params.get("legacy")) : "";
  try {
    const keys = [...new Set([identity, scope, legacy].filter(Boolean))];
    const rows = (await request(
      `rr_device_preferences?select=device_key,appearance,inbox_layout&device_key=in.(${keys
        .map((key) => `"${encodeURIComponent(key)}"`)
        .join(",")})`,
    )) as Row[] | null;
    const byKey = new Map(
      (Array.isArray(rows) ? rows : []).map((row) => [String(row.device_key), row]),
    );
    const appearanceRow = byKey.get(identity) ?? (legacy ? byKey.get(legacy) : undefined);
    const layoutRow = byKey.get(scope) ?? (legacy ? byKey.get(legacy) : undefined);
    return NextResponse.json({
      ok: true,
      scope,
      identity,
      preferences:
        appearanceRow || layoutRow
          ? {
              appearance: appearanceRow?.appearance ?? {},
              layout: layoutRow?.inbox_layout ?? {},
            }
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
  const identity = body.identity ? safeScope(body.identity) : scope;
  const preferences = body.preferences as Row;
  const upsert = (deviceKey: string, columns: Row) =>
    request("rr_device_preferences?on_conflict=device_key", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        device_key: deviceKey,
        ...columns,
        updated_at: new Date().toISOString(),
      }),
    });
  try {
    // Written as two rows on purpose: the identity row is the one every page of the site
    // reads its appearance from, so a change made inside a client inbox has to land there
    // and not on the client. Columns absent from the payload are left alone.
    if (preferences.appearance)
      await upsert(identity, { appearance: preferences.appearance });
    if (preferences.layout)
      await upsert(scope, { inbox_layout: preferences.layout });
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
  const response = NextResponse.json({ ok: true, scope, identity });
  // Appearance only. Layout is per client now, and a cookie has no idea which client it came
  // from — that is how a client's pane split used to leak into every other view.
  response.cookies.set(
    "reply-radar-preferences",
    JSON.stringify({ appearance: preferences.appearance ?? {} }),
    {
      httpOnly: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365 * 2,
      path: "/",
    },
  );
  await writeAuditEvent(config(), {
    actor: "Dashboard user",
    action: Array.isArray(
      (preferences.layout as Row | undefined)?.starredLeadIds,
    )
      ? "lead.stars.saved"
      : "appearance.saved",
    entityType: "preferences",
    entityId: identity,
    details: {
      source: "user",
      status: "success",
      summary: `Dashboard preferences were saved for ${identity}${preferences.layout ? ` (layout: ${scope})` : ""}.`,
    },
  });
  return response;
}
