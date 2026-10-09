// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { readSettings, supabaseConfig, type CalendlyConnection } from "../../../../lib/booking-run";
import { calendlyToken } from "../../../../lib/booking-connect";

/**
 * What each connected Calendly token can do, without changing anything. Reads (who it is, its event types,
 * its meetings) are plain GETs. Writes are probed with an empty body: Calendly checks permission before it
 * checks the body, so a 400 means "allowed, body missing" and a 401/403 means "not allowed", and nothing
 * is created either way.
 */
type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const CALENDLY = "https://api.calendly.com";

async function call(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`${CALENDLY}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.text().catch(() => "");
  let data: Row = {};
  try { data = JSON.parse(body) as Row; } catch { data = { message: body.slice(0, 200) }; }
  return { status: response.status, data };
}

const why = (data: Row) => [text(data.title), text(data.message), ...(Array.isArray(data.details) ? (data.details as Row[]).map((d) => `${text(d.parameter)} ${text(d.message)}`.trim()) : [])].filter(Boolean).join(" · ").slice(0, 300);

async function inspect(label: string, token: string) {
  const me = await call(token, "/users/me");
  if (me.status !== 200) return { label, ok: false, status: me.status, error: why(me.data) };
  const user = (me.data.resource ?? {}) as Row;
  const userUri = text(user.uri);
  const [types, meetings, membership] = await Promise.all([
    call(token, `/event_types?user=${encodeURIComponent(userUri)}&count=100`),
    call(token, `/scheduled_events?user=${encodeURIComponent(userUri)}&count=1`),
    call(token, `/organization_memberships?user=${encodeURIComponent(userUri)}`),
  ]);
  const probe = async (path: string) => {
    const result = await call(token, path, { method: "POST", body: "{}" });
    return { status: result.status, allowed: result.status === 400 || result.status === 422, detail: why(result.data) };
  };
  const [createEventType, createOneOff, bookInvitee] = await Promise.all([probe("/event_types"), probe("/one_off_event_types"), probe("/invitees")]);
  const role = text((((membership.data.collection ?? []) as Row[])[0] ?? {}).role);
  return {
    label,
    ok: true,
    user: { name: text(user.name), email: text(user.email), uri: userUri, organization: text(user.current_organization), role },
    eventTypes: types.status === 200
      ? ((types.data.collection ?? []) as Row[]).map((t) => ({ name: text(t.name), minutes: t.duration, active: t.active, kind: text(t.kind), url: text(t.scheduling_url) }))
      : { status: types.status, error: why(types.data) },
    canReadMeetings: meetings.status === 200,
    canCreateEventTypes: createEventType,
    canCreateOneOffEvents: createOneOff,
    canBookMeetings: bookInvitee,
  };
}

export async function GET() {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const settings = await readSettings(config);
  const accounts: Array<Promise<unknown>> = [];
  const shared = await calendlyToken(config, settings.calendly ?? null, text(settings.calendly_token)).catch(() => text(settings.calendly_token));
  if (shared) accounts.push(inspect("QC shared calendar", shared));
  const response = await fetch(`${config.url}/rest/v1/rr_workspaces?select=id,name,calendly_token,calendly_subscription&calendly_token=not.is.null`, {
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    cache: "no-store",
  });
  const rows = response.ok ? ((await response.json().catch(() => [])) as Row[]) : [];
  for (const row of rows) {
    const token = await calendlyToken(config, (row.calendly_subscription ?? null) as CalendlyConnection | null, text(row.calendly_token), text(row.id)).catch(() => text(row.calendly_token));
    if (token) accounts.push(inspect(text(row.name), token));
  }
  return NextResponse.json({ ok: true, accounts: await Promise.all(accounts) }, { headers: { "Cache-Control": "no-store" } });
}
