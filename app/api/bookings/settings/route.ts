// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { normalizeSteps } from "../../../../shared/bookings.mjs";
import {
  DEFAULT_CLAY_WAIT_MINUTES,
  baseUrl,
  clayCallbackUrl,
  clientConfig,
  ensureCallbackSecret,
  readSettings,
  supabaseConfig,
  writeSettings,
  WORKSPACE_COLUMNS,
  type BookingSettings,
} from "../../../lib/booking-run";

/**
 * The Booked meetings page on the Slack tab: the shared setup (Calendly, the Clay table) and each client's
 * switch, filter, channel and steps. Tokens and secrets are never sent back whole, except the cal.com secret,
 * which has to be copied into cal.com.
 */
type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});

async function rest(path: string, init: RequestInit = {}) {
  const config = supabaseConfig()!;
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const body = await response.text().catch(() => "");
  let data: unknown = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = body; }
  return { ok: response.ok, status: response.status, data };
}

/** A channel id out of an id, a #name-less link, or a pasted Slack URL. */
const channelId = (value: unknown) => {
  const raw = text(value);
  const match = raw.match(/\b([CG][A-Z0-9]{8,})\b/);
  return match ? match[1] : raw;
};

function present(settings: BookingSettings, workspaces: Row[], meetings: Row[]) {
  const base = baseUrl(settings);
  const lastByClient = new Map<string, Row>();
  for (const row of meetings) if (!lastByClient.has(text(row.workspace_id))) lastByClient.set(text(row.workspace_id), row);
  return {
    ok: true,
    testChannelSet: Boolean((process.env.SLACK_TEST_CHANNEL_ID ?? "").trim()),
    global: {
      clayWebhookUrl: text(settings.clay_webhook_url),
      clayAuthSet: Boolean(text(settings.clay_auth_token)),
      clayWaitMinutes: Number(settings.clay_wait_minutes) || DEFAULT_CLAY_WAIT_MINUTES,
      callbackUrl: clayCallbackUrl(settings),
      calendly: settings.calendly ? { email: settings.calendly.email, name: settings.calendly.name, scope: settings.calendly.scope, connectedAt: settings.calendly.connected_at } : null,
      lastClayCallback: settings.last_clay_callback ?? null,
    },
    clients: workspaces.map((workspace) => {
      const id = text(workspace.id);
      const config = clientConfig(workspace);
      const own = object(workspace.calendly_subscription);
      const last = lastByClient.get(id);
      const booking = object(last?.booking);
      return {
        id,
        name: text(workspace.name),
        slug: text(workspace.slug),
        logoUrl: text(workspace.logo_url),
        tone: text(workspace.accent_color) || "var(--report-brand)",
        enabled: config.enabled,
        enabledAt: config.enabledAt,
        eventFilter: config.eventFilter,
        channel: config.channel,
        botName: config.botName,
        steps: config.steps,
        hubspotConnected: text(workspace.crm_provider) === "hubspot" && Boolean(text(workspace.crm_api_key_ciphertext)),
        ownCalendly: own.subscription_uri ? { email: text(own.email), scope: text(own.scope) } : null,
        calcom: text(workspace.calcom_secret) ? { url: `${base}/api/webhooks/calcom?client=${id}`, secret: text(workspace.calcom_secret) } : null,
        lastBooking: last ? { name: text(last.invitee_name), at: text(last.created_at), stage: text(booking.stage), error: text(booking.error) } : null,
      };
    }),
  };
}

async function load(request: Request) {
  const config = supabaseConfig()!;
  const settings = await ensureCallbackSecret(config, await readSettings(config), request);
  const [workspaces, meetings] = await Promise.all([
    rest(`rr_workspaces?select=${WORKSPACE_COLUMNS},accent_color&slug=neq.misc&offboarded_at=is.null&order=name.asc`),
    rest(`rr_meetings?select=workspace_id,invitee_name,created_at,booking&booking->>source=not.is.null&order=created_at.desc&limit=300`),
  ]);
  if (!workspaces.ok) {
    const detail = typeof workspaces.data === "string" ? workspaces.data : JSON.stringify(workspaces.data);
    throw new Error(/booking_config|calendly|calcom/.test(detail) ? "Run the booking alerts migration (20261008_booking_alerts.sql) first." : `Could not read clients (${workspaces.status}).`);
  }
  return present(settings, (workspaces.data as Row[]) ?? [], meetings.ok && Array.isArray(meetings.data) ? (meetings.data as Row[]) : []);
}

export async function GET(request: Request) {
  if (!supabaseConfig()) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  try {
    return NextResponse.json(await load(request));
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not load." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const config = supabaseConfig();
  if (!config) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const body = object(await request.json().catch(() => ({})));
  try {
    if (body.global) {
      const g = object(body.global);
      const patch: Partial<BookingSettings> = {};
      if ("clayWebhookUrl" in g) {
        const url = text(g.clayWebhookUrl);
        if (url && !/^https:\/\//i.test(url)) return NextResponse.json({ ok: false, error: "The Clay webhook URL starts with https://" }, { status: 400 });
        patch.clay_webhook_url = url;
      }
      if ("clayAuthToken" in g) patch.clay_auth_token = text(g.clayAuthToken);
      if ("clayWaitMinutes" in g) patch.clay_wait_minutes = Math.min(120, Math.max(1, Math.round(Number(g.clayWaitMinutes) || DEFAULT_CLAY_WAIT_MINUTES)));
      await writeSettings(config, patch);
      return NextResponse.json(await load(request));
    }

    const workspaceId = text(body.workspaceId);
    if (!workspaceId) return NextResponse.json({ ok: false, error: "No client was named." }, { status: 400 });
    const current = await rest(`rr_workspaces?select=id,booking_config,calcom_secret&id=eq.${encodeURIComponent(workspaceId)}&limit=1`);
    const row = Array.isArray(current.data) ? (current.data[0] as Row | undefined) : undefined;
    if (!current.ok || !row) return NextResponse.json({ ok: false, error: "That client could not be read." }, { status: 404 });
    const next = { ...object(row.booking_config) };
    const patch: Row = {};
    if ("eventFilter" in body) next.event_filter = text(body.eventFilter);
    if ("channel" in body) next.channel = channelId(body.channel);
    if ("botName" in body) next.bot_name = text(body.botName);
    if ("steps" in body) next.steps = normalizeSteps(body.steps);
    if (!text(next.channel)) next.enabled = false;
    if (typeof body.enabled === "boolean") {
      if (body.enabled && !text(next.channel)) return NextResponse.json({ ok: false, error: "Set a bookings channel first." }, { status: 400 });
      if (body.enabled && next.enabled !== true) next.enabled_at = new Date().toISOString();
      next.enabled = body.enabled;
    }
    patch.booking_config = next;
    if (body.calcom === "generate") patch.calcom_secret = randomBytes(18).toString("base64url");
    if (body.calcom === "clear") patch.calcom_secret = null;
    const saved = await rest(`rr_workspaces?id=eq.${encodeURIComponent(workspaceId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
    if (!saved.ok) return NextResponse.json({ ok: false, error: `Could not save (${saved.status}).` }, { status: 500 });
    return NextResponse.json(await load(request));
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "Could not save." }, { status: 500 });
  }
}
