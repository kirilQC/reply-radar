// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { createHmac } from "node:crypto";
import { readConfig, writeConfig, deleteConfig } from "./app-config";

/**
 * QC's own Google sign-in (admin@qcgrowth.com, once, for every client): with it, QC Command writes to any
 * sheet that account can edit, so a sheet only has to be made by, or shared with, admin@qcgrowth.com. Kept
 * in rr_app_config under "google_oauth", server side only. The service account stays as the fallback.
 */

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

const KEY = "google_oauth";
export const GOOGLE_REDIRECT_PATH = "/api/google/oauth/callback";
export const GOOGLE_ORIGIN = (process.env.GOOGLE_OAUTH_ORIGIN ?? "https://www.replyradar.dev").replace(/\/$/, "");
const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/spreadsheets"];

type GoogleUser = { refresh_token: string; access_token: string; expires_at: string; email: string; connected_at: string };

function client() {
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new Error("QC Command's Google sign-in is not configured (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET on Vercel).");
  return { id, secret };
}

export const googleOauthConfigured = () => Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() && process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim());

const sign = (payload: string) => createHmac("sha256", client().secret).update(payload).digest("base64url");

/** state = returnPath.issuedAt.signature (the return path base64url'd so it carries no dots). */
export function googleAuthorizeUrl(returnPath: string): string {
  const payload = `${Buffer.from(returnPath).toString("base64url")}.${Date.now()}`;
  const params = new URLSearchParams({
    client_id: client().id,
    redirect_uri: `${GOOGLE_ORIGIN}${GOOGLE_REDIRECT_PATH}`,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    login_hint: "admin@qcgrowth.com",
    state: `${payload}.${sign(payload)}`,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export function readGoogleState(state: string): string | null {
  const [path, issued, signature] = state.split(".");
  if (!path || !issued || !signature || sign(`${path}.${issued}`) !== signature) return null;
  if (Date.now() - Number(issued) > 30 * 60 * 1000) return null;
  const decoded = Buffer.from(path, "base64url").toString();
  return decoded.startsWith("/") ? decoded : "/onboarding";
}

async function token(fields: Record<string, string>): Promise<Row> {
  const { id, secret } = client();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, client_id: id, client_secret: secret }),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => ({}))) as Row;
  if (!response.ok) throw new Error(`Google sign-in failed: ${text(data.error_description) || text(data.error) || response.status}`);
  return data;
}

export async function connectGoogle(code: string): Promise<GoogleUser> {
  const data = await token({ grant_type: "authorization_code", code, redirect_uri: `${GOOGLE_ORIGIN}${GOOGLE_REDIRECT_PATH}` });
  if (!text(data.refresh_token)) throw new Error("Google did not return a long-lived sign-in. Remove QC Command from the account's third-party access and connect again.");
  const info = (await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${text(data.access_token)}` }, cache: "no-store" }).then((r) => r.json()).catch(() => ({}))) as Row;
  const user: GoogleUser = {
    refresh_token: text(data.refresh_token),
    access_token: text(data.access_token),
    expires_at: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString(),
    email: text(info.email),
    connected_at: new Date().toISOString(),
  };
  await writeConfig(KEY, user);
  return user;
}

/** Who QC Command writes to Google as, when signed in (never the tokens). */
export async function googleAccount(): Promise<{ email: string; connectedAt: string } | null> {
  const user = (await readConfig(KEY).catch(() => null)) as GoogleUser | null;
  return user?.refresh_token ? { email: user.email, connectedAt: user.connected_at } : null;
}

/** A live access token for the signed-in Google account, or null when none is connected. */
export async function googleUserToken(): Promise<string | null> {
  const user = (await readConfig(KEY).catch(() => null)) as GoogleUser | null;
  if (!user?.refresh_token) return null;
  if (Date.parse(user.expires_at) - Date.now() > 120_000) return user.access_token;
  const data = await token({ grant_type: "refresh_token", refresh_token: user.refresh_token });
  const next: GoogleUser = { ...user, access_token: text(data.access_token), expires_at: new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString() };
  await writeConfig(KEY, next);
  return next.access_token;
}

export const disconnectGoogle = () => deleteConfig(KEY);
