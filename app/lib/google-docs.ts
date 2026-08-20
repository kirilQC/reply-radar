// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The one place that talks to Google — signs in as a service account and reads a doc's tabs.
 *
 * ── Why a service account, not an API key ────────────────────────────────────────────────────────
 * The Docs REST API is the only endpoint that returns tabs (`documents.get?includeTabsContent=true`), and
 * it does not accept a bare API key however the doc is shared. So Reply Radar authenticates as a service
 * account: a JWT signed with the account's private key here, exchanged for an access token at Google's
 * token endpoint. The upside of the client docs being "anyone with the link" is that no doc has to be
 * shared with the account by hand — an authenticated caller can already read a public doc.
 *
 * ── Why the signing is hand-rolled ───────────────────────────────────────────────────────────────
 * The whole app takes no SDKs. A Google JWT is three base64url segments and an RS256 signature, which
 * `node:crypto` produces directly, so there is nothing here an SDK would do that a dozen lines do not.
 */

import crypto from "node:crypto";
import { flattenDocTabs, parseDocId } from "../../shared/google-doc.mjs";

/** One campaign-messaging tab, mirrored from the pure module's `DocTab` shape. */
export type DocTab = { tabId: string; title: string; markdown: string };

type ServiceAccount = { clientEmail: string; privateKey: string };

/**
 * The service account, or null when Google is not connected.
 *
 * The key is one JSON blob in `GOOGLE_SERVICE_ACCOUNT_KEY`, either raw or base64 — base64 is offered
 * because a multi-line JSON with a PEM private key inside is awkward to paste into some env editors. A key
 * missing either field it is used for reads as "not connected" rather than throwing, so an unconfigured
 * install degrades to a note instead of a crash, the same as the brain and Airtable do.
 */
function serviceAccount(): ServiceAccount | null {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_KEY ?? "").trim();
  if (!raw) return null;
  const json = raw.startsWith("{") ? raw : safeBase64(raw);
  try {
    const parsed = JSON.parse(json) as { client_email?: string; private_key?: string };
    if (parsed.client_email && parsed.private_key) {
      // A key pasted through a shell or a JSON-in-JSON env can arrive with the newlines escaped; PEM
      // parsing needs the real ones back.
      return { clientEmail: parsed.client_email, privateKey: String(parsed.private_key).replace(/\\n/g, "\n") };
    }
  } catch {
    /* An unparseable key is "not connected", handled by the null return. */
  }
  return null;
}

function safeBase64(value: string): string {
  try {
    return Buffer.from(value, "base64").toString("utf8");
  } catch {
    return "";
  }
}

/** Whether a Google service account is configured. Guards every read so callers can note it and move on. */
export function googleDocsConfigured(): boolean {
  return serviceAccount() !== null;
}

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/**
 * A short-lived access token for the Docs API, minted from the service account's key.
 *
 * The JWT is scoped to read-only documents and lives one hour; it is signed and exchanged on every read
 * rather than cached, because a sync runs a few times a day at most and a token cache would be a second
 * thing to get wrong for no measurable saving.
 */
async function accessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64url(
    JSON.stringify({
      iss: account.clientEmail,
      scope: "https://www.googleapis.com/auth/documents.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signingInput = `${header}.${claim}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), account.privateKey);
  const assertion = `${signingInput}.${base64url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const data = (await response.json().catch(() => ({}))) as { access_token?: string; error_description?: string; error?: string };
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google sign-in failed (${response.status}).`);
  }
  return data.access_token;
}

/**
 * Every tab of a Google Doc, as `DocTab`s.
 *
 * Takes the pasted URL or a bare id. A 403 or 404 is translated to the one thing the operator can fix —
 * the doc is not readable — rather than surfaced as a status code, because "share it" is the fix and the
 * service account reads any public doc without being shared to.
 */
export async function fetchMessagingTabs(docUrlOrId: string): Promise<DocTab[]> {
  const account = serviceAccount();
  if (!account) throw new Error("Google is not connected. Set GOOGLE_SERVICE_ACCOUNT_KEY.");
  const docId = parseDocId(docUrlOrId);
  if (!docId) throw new Error("That is not a Google Docs URL.");

  const token = await accessToken(account);
  const response = await fetch(
    `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}?includeTabsContent=true`,
    { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" },
  );
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error("Reply Radar cannot open that document. Set it to \u201Canyone with the link\u201D and try again.");
    }
    const detail = await response.text().catch(() => "");
    throw new Error(`Google Docs returned ${response.status}. ${detail.slice(0, 200)}`.trim());
  }
  const doc = (await response.json().catch(() => ({}))) as { tabs?: unknown[] };
  return flattenDocTabs(doc.tabs ?? []) as DocTab[];
}
