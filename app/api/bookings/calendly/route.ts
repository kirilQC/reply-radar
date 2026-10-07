// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import {
  baseUrl,
  connectCalendly,
  disconnectCalendly,
  ensureCallbackSecret,
  readSettings,
  supabaseConfig,
  writeSettings,
  type CalendlyConnection,
} from "../../../lib/booking-run";

/**
 * Connects or disconnects a Calendly account. Without `workspaceId` it is the shared QC calendar, whose
 * bookings are routed to clients by event name; with one it is that client's own Calendly.
 */
type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

async function patchWorkspace(id: string, patch: Row) {
  const config = supabaseConfig()!;
  const response = await fetch(`${config.url}/rest/v1/rr_workspaces?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw new Error(`Could not save the connection (${response.status}).`);
}

async function readWorkspace(id: string): Promise<Row | null> {
  const config = supabaseConfig()!;
  const response = await fetch(`${config.url}/rest/v1/rr_workspaces?select=id,calendly_token,calendly_subscription&id=eq.${encodeURIComponent(id)}&limit=1`, {
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}` },
    cache: "no-store",
  });
  const rows = response.ok ? await response.json().catch(() => []) : [];
  return Array.isArray(rows) && rows[0] ? (rows[0] as Row) : null;
}

export async function POST(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = (await request.json().catch(() => ({}))) as Row;
  const token = text(body.token);
  const workspaceId = text(body.workspaceId);
  if (!token) return NextResponse.json({ ok: false, error: "Paste a Calendly personal access token." }, { status: 400 });
  try {
    const settings = await ensureCallbackSecret(config, await readSettings(config), request);
    const url = `${baseUrl(settings)}/api/webhooks/calendly${workspaceId ? `?client=${encodeURIComponent(workspaceId)}` : ""}`;
    // Replacing a connection: the old subscription is removed first so Calendly does not post twice.
    if (workspaceId) {
      const current = await readWorkspace(workspaceId);
      if (!current) return NextResponse.json({ ok: false, error: "Unknown client." }, { status: 404 });
      await disconnectCalendly(text(current.calendly_token), current.calendly_subscription as CalendlyConnection | null);
    } else {
      await disconnectCalendly(text(settings.calendly_token), settings.calendly ?? null);
    }
    const result = await connectCalendly(token, url);
    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    if (workspaceId) await patchWorkspace(workspaceId, { calendly_token: token, calendly_subscription: result.connection });
    else await writeSettings(config, { calendly_token: token, calendly: result.connection });
    return NextResponse.json({ ok: true, email: result.connection.email, scope: result.connection.scope });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not connect." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const workspaceId = text(new URL(request.url).searchParams.get("workspaceId"));
  try {
    if (workspaceId) {
      const current = await readWorkspace(workspaceId);
      if (current) await disconnectCalendly(text(current.calendly_token), current.calendly_subscription as CalendlyConnection | null);
      await patchWorkspace(workspaceId, { calendly_token: null, calendly_subscription: null });
    } else {
      const settings = await readSettings(config);
      await disconnectCalendly(text(settings.calendly_token), settings.calendly ?? null);
      await writeSettings(config, { calendly_token: "", calendly: null });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not disconnect." }, { status: 500 });
  }
}
