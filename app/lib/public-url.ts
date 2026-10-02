// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The address this app answers on, from the outside.
 *
 * ── Why this needs deciding at all ──────────────────────────────────────────────────────────────
 * Almost nothing here cares: the browser calls its own origin with relative paths and the server
 * talks to Supabase and HeyReach by their own URLs. The exception is a URL we hand to somebody else
 * to call us back on — a HeyReach webhook — which is pasted into another company's dashboard, stored
 * in our own table, and then only discovered to be wrong when a client's replies stop arriving.
 * That one has to be a real, current, public address, and it used to be a hardcoded `.vercel.app`
 * host: correct on the day it was typed and silently stale the moment the domain changed.
 *
 * ── The order, and why ──────────────────────────────────────────────────────────────────────────
 * 1. `APP_BASE_URL`, if set. An explicit answer beats an inferred one, and it is the same variable
 *    the render worker already uses, so one value describes the deployment to everything.
 * 2. `ROOT_DOMAIN`, if set. Whoever configured client subdomains has already named the public apex;
 *    asking them to name it twice is how the two drift apart.
 * 3. The host the request arrived on. Always right for the request being served, which is why it is
 *    the fallback — but not the first choice, because a value read on a preview deployment gets
 *    *stored*, and a webhook pointing at a preview build is a webhook that dies with the branch.
 *
 * A scheme is assumed rather than demanded, because `ROOT_DOMAIN` is a bare hostname by design and
 * `APP_BASE_URL` is typed by hand into a dashboard where "https://" is the easiest thing to forget.
 */

const normalise = (value: string | undefined) => {
  const trimmed = (value ?? "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  try {
    return new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).origin;
  } catch {
    return "";
  }
};

export function publicBaseUrl(request?: Request): string {
  const configured = normalise(process.env.APP_BASE_URL) || normalise(process.env.ROOT_DOMAIN);
  if (configured) return configured;

  // Forwarded headers rather than `request.url`: behind Vercel's proxy the latter can carry the
  // internal host, and the whole point of this value is the host the outside world used.
  const headers = request?.headers;
  const host = headers?.get("x-forwarded-host") || headers?.get("host") || "";
  if (host) {
    const proto = headers?.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
    const derived = normalise(`${proto}://${host}`);
    if (derived) return derived;
  }
  return "";
}

/**
 * Where HeyReach should post this client's replies. Encoded because the slug is a path segment: a slug
 * saved before slugs were normalised can still hold a space or a slash, and an unencoded one would point
 * HeyReach at a different route entirely.
 */
export const webhookUrlFor = (slug: unknown, request?: Request) =>
  `${publicBaseUrl(request)}/api/webhooks/heyreach/${encodeURIComponent(String(slug ?? ""))}`;

/**
 * Whether a webhook URL already on a workspace still points at us.
 *
 * A stored URL is only replaced when its origin is not the one we answer on now — so a domain change
 * heals every client's webhook the next time the admin console is opened, while a URL somebody
 * deliberately pointed somewhere else is left alone. It used to check for one specific stale host by
 * name, which fixed exactly the one migration it was written for.
 */
export const isOurWebhookUrl = (value: unknown, base: string) => {
  const held = typeof value === "string" ? value.trim() : "";
  if (!held || !base) return Boolean(held);
  try {
    return new URL(held).origin === base;
  } catch {
    return false;
  }
};

/**
 * A workspace slug in the one shape every part of the app expects: lowercase letters, digits and single
 * hyphens, nothing at either end.
 *
 * The slug is a path segment in the HeyReach webhook URL, a key in the brain link and a query parameter
 * all over the app, so a space or an uppercase letter typed into the admin form used to become a webhook
 * address that only worked when somebody encoded it by hand. Applied on the client as the field is typed
 * and again on the server, because the server is the one that stores it.
 */
export const workspaceSlug = (value: unknown) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Where the login page may send somebody after a correct password: a path on this site, or "/".
 *
 * `next` arrives from the query string already decoded, so `?next=/%5Cevil.com` reads as `/\evil.com`,
 * which a browser treats as `//evil.com` and leaves the site. A prefix check on the raw string cannot see
 * that, so the value is resolved against our own origin and only kept if it is still ours and still a
 * single-slash path. Backslashes and control characters are refused outright, because browsers rewrite
 * both before resolving and the rewrite is where these tricks live.
 */
export function safeNextPath(next: string | null | undefined, origin: string): string {
  const raw = String(next ?? "");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.includes("\\") || [...raw].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)) return "/";
  try {
    const home = new URL(origin);
    const resolved = new URL(raw, home);
    if (resolved.origin !== home.origin) return "/";
    if (!resolved.pathname.startsWith("/") || resolved.pathname.startsWith("//")) return "/";
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return "/";
  }
}
