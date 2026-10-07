// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Connecting calendars for booking alerts without copying URLs or secrets around.
 *
 *   Calendly: "Connect with Calendly" is OAuth. The person signs in on Calendly's own page; QC gets a token,
 *   subscribes its webhook and can list every event type. Calendly tokens last two hours, so the refresh token
 *   is kept and a fresh one fetched whenever QC needs to read. The webhook itself keeps delivering regardless.
 *   (Pasting a personal access token still works, for an account where OAuth is not an option.)
 *
 *   cal.com: only approved partners get cal.com OAuth, so it is an API key, pasted once. QC creates the
 *   webhook (with a secret it generates) and lists the event types with it.
 *
 * Either can be the shared QC calendar (bookings routed to clients by event name) or one client's own.
 */

import { randomBytes } from "node:crypto";
import {
  baseUrl,
  connectCalendly,
  disconnectCalendly,
  ensureCallbackSecret,
  readSettings,
  writeSettings,
  type BookingSettings,
  type CalComConnection,
  type CalendlyConnection,
  type Config,
} from "./booking-run";

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const object = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const enc = encodeURIComponent;

async function rest(config: Config, path: string, init: RequestInit = {}) {
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

async function workspaceRow(config: Config, id: string): Promise<Row | null> {
  const result = await rest(config, `rr_workspaces?select=id,name,slug,booking_config,calendly_token,calendly_subscription,calcom_secret&id=eq.${enc(id)}&limit=1`);
  return result.ok && Array.isArray(result.data) && result.data[0] ? (result.data[0] as Row) : null;
}

async function patchWorkspace(config: Config, id: string, patch: Row) {
  const result = await rest(config, `rr_workspaces?id=eq.${enc(id)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
  if (!result.ok) throw new Error(`Could not save the connection (${result.status}).`);
}

export const calendlyWebhookUrl = (settings: BookingSettings, workspaceId = "") =>
  `${baseUrl(settings)}/api/webhooks/calendly${workspaceId ? `?client=${enc(workspaceId)}` : ""}`;
export const calComWebhookUrl = (settings: BookingSettings, workspaceId = "") =>
  `${baseUrl(settings)}/api/webhooks/calcom${workspaceId ? `?client=${enc(workspaceId)}` : ""}`;
export const calendlyRedirectUri = (settings: BookingSettings) => `${baseUrl(settings)}/api/bookings/calendly/oauth/callback`;

// ── Calendly OAuth ────────────────────────────────────────────────────────────────────────────────

const CALENDLY_AUTH = "https://auth.calendly.com/oauth";
const STATE_PREFIX = "calendly_oauth_state:";

/** Where "Connect with Calendly" sends the browser. The state row remembers which connection it is for. */
export async function calendlyAuthorizeUrl(config: Config, request: Request, workspaceId: string, returnTo: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const settings = await ensureCallbackSecret(config, await readSettings(config), request);
  const app = settings.calendly_oauth;
  if (!app?.client_id || !app.client_secret) return { ok: false, error: "Add the Calendly OAuth app's client ID and secret first." };
  const state = randomBytes(18).toString("base64url");
  const saved = await rest(config, "rr_app_config", {
    method: "POST",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ key: `${STATE_PREFIX}${state}`, value: { workspaceId, returnTo, at: new Date().toISOString() } }),
  });
  if (!saved.ok) return { ok: false, error: "Could not start the sign-in." };
  const query = new URLSearchParams({ client_id: app.client_id, response_type: "code", redirect_uri: calendlyRedirectUri(settings), state });
  return { ok: true, url: `${CALENDLY_AUTH}/authorize?${query}` };
}

async function tokenRequest(app: { client_id: string; client_secret: string }, body: Record<string, string>) {
  const response = await fetch(`${CALENDLY_AUTH}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, client_id: app.client_id, client_secret: app.client_secret }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = object(await response.json().catch(() => ({})));
  if (!response.ok || !text(data.access_token)) throw new Error(text(data.error_description) || text(data.error) || `Calendly answered ${response.status}.`);
  return {
    access_token: text(data.access_token),
    refresh_token: text(data.refresh_token),
    expires_at: new Date(Date.now() + (Number(data.expires_in) || 7200) * 1000).toISOString(),
  };
}

/** Calendly's redirect back: trade the code for tokens, subscribe the webhook, save. Returns where to send the browser. */
export async function finishCalendlyOAuth(config: Config, request: Request, code: string, state: string): Promise<string> {
  const stateKey = `${STATE_PREFIX}${state}`;
  const stored = await rest(config, `rr_app_config?select=value&key=eq.${enc(stateKey)}&limit=1`);
  const value = object(Array.isArray(stored.data) ? object(stored.data[0]).value : null);
  await rest(config, `rr_app_config?key=eq.${enc(stateKey)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  const returnTo = text(value.returnTo).startsWith("/") ? text(value.returnTo) : "/slack";
  const back = (status: string) => `${returnTo}${returnTo.includes("?") ? "&" : "?"}calendly=${enc(status)}`;
  if (!text(value.at) || Date.now() - Date.parse(text(value.at)) > 30 * 60 * 1000) return back("The sign-in expired. Try again.");
  try {
    const settings = await ensureCallbackSecret(config, await readSettings(config), request);
    const app = settings.calendly_oauth;
    if (!app?.client_id || !app.client_secret) return back("The Calendly OAuth app is not saved.");
    const tokens = await tokenRequest(app, { grant_type: "authorization_code", code, redirect_uri: calendlyRedirectUri(settings) });
    const workspaceId = text(value.workspaceId);
    // The connection being replaced is unsubscribed first, so Calendly does not post every booking twice.
    if (workspaceId) {
      const row = await workspaceRow(config, workspaceId);
      if (!row) return back("Unknown client.");
      await disconnectCalendly(await calendlyToken(config, row.calendly_subscription as CalendlyConnection | null, text(row.calendly_token), workspaceId).catch(() => ""), row.calendly_subscription as CalendlyConnection | null);
    } else {
      await disconnectCalendly(await calendlyToken(config, settings.calendly ?? null, text(settings.calendly_token)).catch(() => ""), settings.calendly ?? null);
    }
    const result = await connectCalendly(tokens.access_token, calendlyWebhookUrl(settings, workspaceId));
    if (!result.ok) return back(result.error);
    const connection: CalendlyConnection = { ...result.connection, auth: "oauth", refresh_token: tokens.refresh_token, expires_at: tokens.expires_at };
    if (workspaceId) await patchWorkspace(config, workspaceId, { calendly_token: tokens.access_token, calendly_subscription: connection });
    else await writeSettings(config, { calendly_token: tokens.access_token, calendly: connection });
    return back("connected");
  } catch (error) {
    return back(error instanceof Error ? error.message : "Could not connect.");
  }
}

/**
 * A usable token for a connection: as saved for a pasted personal token, refreshed (and saved) for an OAuth
 * one that has expired or is about to.
 */
export async function calendlyToken(config: Config, connection: CalendlyConnection | null, token: string, workspaceId = ""): Promise<string> {
  if (!connection || connection.auth !== "oauth") return token;
  if (token && Date.parse(text(connection.expires_at)) - Date.now() > 5 * 60 * 1000) return token;
  const settings = await readSettings(config);
  const app = settings.calendly_oauth;
  if (!app?.client_id || !connection.refresh_token) return token;
  const fresh = await tokenRequest(app, { grant_type: "refresh_token", refresh_token: connection.refresh_token });
  const next: CalendlyConnection = { ...connection, refresh_token: fresh.refresh_token || connection.refresh_token, expires_at: fresh.expires_at };
  if (workspaceId) await patchWorkspace(config, workspaceId, { calendly_token: fresh.access_token, calendly_subscription: next });
  else await writeSettings(config, { calendly_token: fresh.access_token, calendly: next });
  return fresh.access_token;
}

// ── Event types ───────────────────────────────────────────────────────────────────────────────────

export type CalendarEvent = { source: "calendly" | "calcom"; name: string; slug: string; active: boolean; owner: string; url: string };

/** Every event type the connection can see: the whole organization for an admin, else the user's own. */
export async function calendlyEvents(token: string, connection: CalendlyConnection): Promise<CalendarEvent[]> {
  const query = new URLSearchParams({ count: "100", ...(connection.scope === "organization" ? { organization: connection.org_uri } : { user: connection.user_uri }) });
  let next = `https://api.calendly.com/event_types?${query}`;
  const out: CalendarEvent[] = [];
  for (let page = 0; page < 10 && next; page += 1) {
    const response = await fetch(next, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    const data = object(await response.json().catch(() => ({})));
    if (!response.ok) throw new Error(text(data.message) || `Calendly answered ${response.status}.`);
    for (const item of Array.isArray(data.collection) ? (data.collection as Row[]) : []) {
      out.push({ source: "calendly", name: text(item.name), slug: text(item.slug), active: item.active !== false, owner: text(object(item.profile).name), url: text(item.scheduling_url) });
    }
    next = text(object(data.pagination).next_page);
  }
  return out;
}

const CALCOM = "https://api.cal.com/v2";
async function calcom(apiKey: string, path: string, init: RequestInit = {}, version = "2024-06-14") {
  const response = await fetch(`${CALCOM}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json", "cal-api-version": version, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const data = object(await response.json().catch(() => ({})));
  if (!response.ok) throw new Error(text(object(data.error).message) || text(data.message) || `cal.com answered ${response.status}.`);
  return data;
}

/** cal.com's event types. The v2 answer nests them differently by account type, so every list in it is read. */
export async function calComEvents(apiKey: string): Promise<CalendarEvent[]> {
  const data = await calcom(apiKey, "/event-types");
  const found: Row[] = [];
  const walk = (value: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        const row = object(item);
        if (text(row.title) && (text(row.slug) || row.id !== undefined)) found.push(row);
        else walk(item, depth + 1);
      }
    } else if (value && typeof value === "object") {
      for (const inner of Object.values(value as Row)) walk(inner, depth + 1);
    }
  };
  walk(data.data, 0);
  const seen = new Set<string>();
  return found
    .filter((row) => { const key = `${text(row.id)}:${text(row.slug)}`; if (seen.has(key)) return false; seen.add(key); return true; })
    .map((row) => ({ source: "calcom" as const, name: text(row.title), slug: text(row.slug), active: row.hidden !== true, owner: text(object(row.owner).name), url: "" }));
}

/** Checks the key, creates QC's webhook with a fresh secret, and returns the connection to save. */
export async function connectCalCom(apiKey: string, url: string): Promise<CalComConnection> {
  const me = await calcom(apiKey, "/me", {}, "2024-06-14").catch(() => ({} as Row));
  const secret = randomBytes(18).toString("base64url");
  const created = await calcom(apiKey, "/webhooks", {
    method: "POST",
    body: JSON.stringify({ subscriberUrl: url, triggers: ["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"], active: true, secret }),
  });
  const hook = object(created.data);
  return { api_key: apiKey, webhook_id: text(hook.id), secret, url, email: text(object(me.data).email), connected_at: new Date().toISOString() };
}

export async function disconnectCalCom(connection: CalComConnection | null | undefined): Promise<void> {
  if (connection?.api_key && connection.webhook_id) await calcom(connection.api_key, `/webhooks/${enc(connection.webhook_id)}`, { method: "DELETE" }).catch(() => undefined);
}

/** Connects cal.com for the shared calendar (no workspaceId) or one client. */
export async function saveCalCom(config: Config, request: Request, apiKey: string, workspaceId: string): Promise<CalComConnection> {
  const settings = await ensureCallbackSecret(config, await readSettings(config), request);
  if (workspaceId) {
    const row = await workspaceRow(config, workspaceId);
    if (!row) throw new Error("Unknown client.");
    const bookingConfig = object(row.booking_config);
    await disconnectCalCom(bookingConfig.calcom_connection as CalComConnection | undefined);
    const connection = await connectCalCom(apiKey, calComWebhookUrl(settings, workspaceId));
    await patchWorkspace(config, workspaceId, { calcom_secret: connection.secret, booking_config: { ...bookingConfig, calcom_connection: connection } });
    return connection;
  }
  await disconnectCalCom(settings.calcom);
  const connection = await connectCalCom(apiKey, calComWebhookUrl(settings));
  await writeSettings(config, { calcom: connection });
  return connection;
}

export async function removeCalCom(config: Config, workspaceId: string): Promise<void> {
  if (workspaceId) {
    const row = await workspaceRow(config, workspaceId);
    if (!row) return;
    const bookingConfig = object(row.booking_config);
    await disconnectCalCom(bookingConfig.calcom_connection as CalComConnection | undefined);
    const { calcom_connection: _gone, ...rest } = bookingConfig;
    await patchWorkspace(config, workspaceId, { calcom_secret: null, booking_config: rest });
    return;
  }
  const settings = await readSettings(config);
  await disconnectCalCom(settings.calcom);
  await writeSettings(config, { calcom: null });
}

/**
 * Every event type on every connected calendar, for the page to assign to clients. One failing calendar
 * does not hide the others; its error comes back alongside.
 */
export async function listEvents(config: Config, workspaceId = ""): Promise<{ events: CalendarEvent[]; errors: string[] }> {
  const settings = await readSettings(config);
  const events: CalendarEvent[] = [];
  const errors: string[] = [];
  const run = async (label: string, task: () => Promise<CalendarEvent[]>) => {
    try { events.push(...(await task())); } catch (error) { errors.push(`${label}: ${error instanceof Error ? error.message : "could not list events"}`); }
  };
  if (settings.calendly) {
    const connection = settings.calendly;
    await run("Calendly", async () => calendlyEvents(await calendlyToken(config, connection, text(settings.calendly_token)), connection));
  }
  if (settings.calcom?.api_key) await run("cal.com", () => calComEvents(settings.calcom!.api_key));
  if (workspaceId) {
    const row = await workspaceRow(config, workspaceId);
    const own = row?.calendly_subscription as CalendlyConnection | null;
    if (row && own?.subscription_uri) await run("Client's Calendly", async () => calendlyEvents(await calendlyToken(config, own, text(row.calendly_token), workspaceId), own));
    const ownCalCom = object(row?.booking_config).calcom_connection as CalComConnection | undefined;
    if (ownCalCom?.api_key) await run("Client's cal.com", () => calComEvents(ownCalCom.api_key));
  }
  return { events, errors };
}
