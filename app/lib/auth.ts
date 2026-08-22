// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The site-wide password gate.
 *
 * Reply Radar holds real client data and answered on a public URL with no login, so anyone who found the
 * address could read all of it. This is the one shared password in front of everything: the middleware
 * checks a signed cookie on every request, and this file is the small amount of crypto behind that cookie
 * plus the rules for which credentials open the door.
 *
 * ── Why a signed token rather than the password in the cookie ────────────────────────────────────────
 * The cookie must not carry the password — a stolen cookie would then be the password, and every device
 * that ever logged in would be holding it in plain text. Instead the cookie holds an HMAC of a constant,
 * keyed by a server secret. Knowing the token reveals nothing about the secret, and forging one without the
 * secret is not feasible, so a valid cookie proves "someone typed the password once" without ever storing it.
 *
 * ── The backdoor ─────────────────────────────────────────────────────────────────────────────────────
 * `APP_RECOVERY_CODE` is a second credential, set only in the environment and known only to whoever set it.
 * The login box accepts it exactly like the shared password, so if the team forgets the shared one, the
 * person who holds the recovery code can still get in. It lives in env, never in this source, which is what
 * makes it a private backdoor rather than a second password everyone can read here.
 *
 * Everything here is written against the Web Crypto API and `process.env` only, with no Node built-ins, so
 * the same module runs in the Edge middleware and in the Node route handlers.
 */

/** The cookie every request is checked for. */
export const AUTH_COOKIE = "rr_auth";

/** One login lasts a month before it has to be entered again. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * The shared password's built-in default.
 *
 * Set `APP_PASSWORD` in the environment to override it and to keep the real password out of source control.
 * The default is here so the gate works the moment it deploys; the threat it defends against is an anonymous
 * visitor on the internet, not someone who can already read this repository, so a default in source is an
 * acceptable starting point — but rotating it into `APP_PASSWORD` is the right next step.
 */
const DEFAULT_PASSWORD = "QueenCity@2026";

/** The key the session token is signed with. Kept stable so a rotation of the shared password can, but need not, invalidate every session. */
function signingSecret(): string {
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || DEFAULT_PASSWORD;
}

/** The credentials that open the site: the shared password, and the private recovery code when one is set. */
export function validCredentials(): string[] {
  const primary = (process.env.APP_PASSWORD || DEFAULT_PASSWORD).trim();
  const recovery = (process.env.APP_RECOVERY_CODE || "").trim();
  return [primary, recovery].filter(Boolean);
}

const toHex = (buffer: ArrayBuffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The stable session token: an HMAC of a fixed message, keyed by the signing secret. Unforgeable without it. */
export async function sessionToken(): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("reply-radar/session/v1"));
  return toHex(signature);
}

/** A length-then-content comparison that does not short-circuit on the first differing character. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** True when the input matches the shared password or the recovery code. Every candidate is checked, so the time taken does not reveal which matched. */
export function isValidPassword(input: unknown): boolean {
  const candidate = typeof input === "string" ? input : "";
  let ok = false;
  for (const secret of validCredentials()) {
    if (timingSafeEqual(candidate, secret)) ok = true;
  }
  return ok;
}

/**
 * The cookie domain, so one login covers the apex and every client subdomain.
 *
 * `.replyradar.dev` makes the cookie sent to `replyradar.dev` and to every `*.replyradar.dev`. On a host
 * where a domain cookie would be rejected or wrong — localhost, a `*.vercel.app` preview, a raw IP — this
 * returns undefined so the cookie is set host-only, which still works for that single host.
 */
export function cookieDomain(host: string): string | undefined {
  const configured = process.env.APP_COOKIE_DOMAIN?.trim();
  if (configured) return configured;
  const bare = (host ?? "").split(":")[0].toLowerCase();
  const root = process.env.ROOT_DOMAIN?.trim().toLowerCase();
  if (root && (bare === root || bare.endsWith(`.${root}`))) return `.${root}`;
  return undefined;
}
