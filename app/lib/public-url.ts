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

/** Where HeyReach should post this client's replies. */
export const webhookUrlFor = (slug: unknown, request?: Request) =>
  `${publicBaseUrl(request)}/api/webhooks/heyreach/${String(slug ?? "")}`;

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
