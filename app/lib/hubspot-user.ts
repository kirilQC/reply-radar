// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { createHmac } from "node:crypto";
import { saveDestination, type Config, type Destination } from "./crm-push";

/**
 * The QC Growth user's own sign-in to a client's HubSpot, through QC Growth's HubSpot app (user-level access,
 * one app in QC's developer account, installed once per client portal). A service key acts as nobody, so
 * HubSpot refuses it reports and dashboards; this sign-in acts as the QC Growth user, who can build both.
 * Tokens live in rr_crm_push.config.hubspot_user, server side only (presentDestination strips them).
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

export const HUBSPOT_USER_SCOPES = ["oauth", "reporting.full.write", "crm.objects.contacts.read"];
export const HUBSPOT_USER_OPTIONAL_SCOPES = ["reporting.full.admin"];
export const HUBSPOT_REDIRECT_PATH = "/api/hubspot/oauth/callback";
/** The one origin registered as the app's redirect URL; client subdomains share its session cookie. */
export const OAUTH_ORIGIN = (process.env.HUBSPOT_OAUTH_ORIGIN ?? "https://www.replyradar.dev").replace(/\/$/, "");

export type HubSpotUser = { refresh_token: string; access_token: string; expires_at: string; hub_id: string; user: string; scopes: string[]; connected_at: string };

function app() {
  const clientId = process.env.HUBSPOT_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.HUBSPOT_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) throw new Error("QC Growth's HubSpot app is not configured (HUBSPOT_APP_CLIENT_ID and HUBSPOT_APP_CLIENT_SECRET on Vercel).");
  return { clientId, clientSecret };
}

export function hubspotAppConfigured(): boolean {
  return Boolean(process.env.HUBSPOT_APP_CLIENT_ID?.trim() && process.env.HUBSPOT_APP_CLIENT_SECRET?.trim());
}

const sign = (payload: string) => createHmac("sha256", app().clientSecret).update(payload).digest("base64url");

/** state = slug.issuedAt.signature, so the callback knows which client it is for and that QC Command sent it. */
export function oauthState(slug: string): string {
  const payload = `${slug}.${Date.now()}`;
  return `${payload}.${sign(payload)}`;
}

export function readOauthState(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 3) return null;
  const [slug, issued, signature] = parts;
  if (sign(`${slug}.${issued}`) !== signature) return null;
  if (Date.now() - Number(issued) > 30 * 60 * 1000) return null;
  return slug;
}

/** With the client's portal id, HubSpot opens straight on that account instead of asking which one. */
export function authorizeUrl(origin: string, slug: string, portalId?: string | null): string {
  const { clientId } = app();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${origin}${HUBSPOT_REDIRECT_PATH}`,
    scope: HUBSPOT_USER_SCOPES.join(" "),
    optional_scope: HUBSPOT_USER_OPTIONAL_SCOPES.join(" "),
    state: oauthState(slug),
  });
  return `https://app.hubspot.com/oauth/${portalId && /^\d+$/.test(portalId) ? `${portalId}/` : ""}authorize?${params}`;
}

async function tokenRequest(fields: Record<string, string>): Promise<Row> {
  const { clientId, clientSecret } = app();
  const response = await fetch("https://api.hubapi.com/oauth/v1/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, client_id: clientId, client_secret: clientSecret }),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok) throw new Error(text(data.message) || `HubSpot sign-in failed (${response.status}).`);
  return data;
}

/** Exchanges the callback's code, then asks HubSpot which portal and user the sign-in belongs to. */
export async function exchangeCode(origin: string, code: string): Promise<HubSpotUser> {
  const token = await tokenRequest({ grant_type: "authorization_code", redirect_uri: `${origin}${HUBSPOT_REDIRECT_PATH}`, code });
  const info = (await fetch(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(text(token.access_token))}`, { cache: "no-store" }).then((r) => r.json()).catch(() => ({}))) as Row;
  return {
    refresh_token: text(token.refresh_token),
    access_token: text(token.access_token),
    expires_at: new Date(Date.now() + (Number(token.expires_in) || 1800) * 1000).toISOString(),
    hub_id: text(info.hub_id),
    user: text(info.user),
    scopes: Array.isArray(info.scopes) ? info.scopes.map(text) : [],
    connected_at: new Date().toISOString(),
  };
}

export function hubspotUserOf(destination: Destination | null): HubSpotUser | null {
  const user = (destination?.config ?? {}).hubspot_user as HubSpotUser | undefined;
  return user?.refresh_token ? user : null;
}

/** A live access token for the QC Growth user, refreshed (and saved) when it is about to expire. */
export async function hubspotUserToken(config: Config, destination: Destination): Promise<string | null> {
  const user = hubspotUserOf(destination);
  if (!user) return null;
  if (Date.parse(user.expires_at) - Date.now() > 120_000) return user.access_token;
  const token = await tokenRequest({ grant_type: "refresh_token", refresh_token: user.refresh_token });
  const next: HubSpotUser = { ...user, access_token: text(token.access_token), refresh_token: text(token.refresh_token) || user.refresh_token, expires_at: new Date(Date.now() + (Number(token.expires_in) || 1800) * 1000).toISOString() };
  await saveDestination(config, destination.workspace_id, "crm", { config: { ...(destination.config ?? {}), hubspot_user: next } });
  destination.config = { ...(destination.config ?? {}), hubspot_user: next };
  return next.access_token;
}
