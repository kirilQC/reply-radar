// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, authConfigured, sessionToken, timingSafeEqual } from "./app/lib/auth";

/**
 * Two jobs, in order: put the whole site behind one shared password, then — for a request that is allowed
 * through — give each client their subdomain.
 *
 * ── The password gate ───────────────────────────────────────────────────────────────────────────────
 * Every request is checked for a valid session cookie. Without one, a page is redirected to `/login` and an
 * API call gets a 401. One login sets a cookie scoped to the whole domain, so it covers the apex and every
 * client subdomain and lasts a month (see app/lib/auth.ts).
 *
 * ── What is deliberately NOT gated, and why ─────────────────────────────────────────────────────────
 * Some endpoints are called by machines that have no cookie and never will: HeyReach posts to the webhook
 * routes, Slack posts to the events route, and the Render worker calls the AI, Slack, Granola and purge
 * routes to run the scheduled work. Gating those would silently break inbound replies, enrichment and the
 * morning brief. They authenticate themselves where it matters (a webhook secret in the path, a Slack
 * signature) and were reachable without a login before this change, so leaving them as they were neither
 * breaks automation nor exposes anything the browsable app did not already. Everything a person can browse
 * to — every page and every data API the pages read — is behind the password.
 */

/** Labels that are never a client subdomain. `www` is the one that matters; the rest are reserved. */
const RESERVED = new Set(["www", "app", "api", "admin", "vercel", "localhost"]);

/** The login screen and the endpoints that log a person in — reachable without a session, by definition. */
function isAuthPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/api/auth/");
}

/**
 * A Vercel cron invocation. Vercel attaches `Authorization: Bearer <CRON_SECRET>` to scheduled requests when
 * the CRON_SECRET env var is set, and those requests carry no login cookie — so without this they would hit
 * the gate and 401, which is exactly what silently broke brain/warm and messaging/sync when the gate landed.
 */
function isCron(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * Endpoints called by machines rather than browsers, which carry no session cookie. Left ungated so the
 * webhooks, the Slack event handler and the scheduled worker keep working; each is self-secured or was
 * already open before the gate existed. Everything else under /api is behind the password.
 */
function isMachinePath(pathname: string): boolean {
  return (
    pathname.startsWith("/api/webhooks/") || // HeyReach — secret in the path
    pathname.startsWith("/api/slack/") || // Slack events, and the worker's brief / EOW / call-analysis
    pathname.startsWith("/api/ai/") || // the worker's enrichment, drafting and scoring
    pathname.startsWith("/api/granola/") || // Granola heartbeats
    pathname === "/api/heartbeat" || // liveness ping
    pathname === "/api/database/purge" // the worker's retention purge
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (!isAuthPath(pathname) && !isMachinePath(pathname) && !isCron(request)) {
    const cookie = request.cookies.get(AUTH_COOKIE)?.value ?? "";
    const expected = await sessionToken();
    // authConfigured() gates first: with no password set the signing secret is a public constant, so a cookie
    // must never be trusted — everyone is sent to /login, which then says login is not configured.
    const authed = authConfigured() && Boolean(cookie) && timingSafeEqual(cookie, expected);
    if (!authed) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
      }
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      const next = pathname + request.nextUrl.search;
      url.search = "";
      // Send the reader back where they were headed once they are in — but only within this site.
      if (next && next !== "/" && next.startsWith("/") && !next.startsWith("//")) url.searchParams.set("next", next);
      return NextResponse.redirect(url);
    }
  }

  // Allowed through. Keep the client-subdomain rewrite exactly as it was.
  const rootDomain = process.env.ROOT_DOMAIN?.trim().toLowerCase();
  if (rootDomain) {
    const host = (request.headers.get("host") ?? "").split(":")[0].toLowerCase();
    if (host !== rootDomain && host.endsWith(`.${rootDomain}`)) {
      const slug = host.slice(0, -(rootDomain.length + 1));
      if (slug && !slug.includes(".") && !RESERVED.has(slug)) {
        const url = request.nextUrl.clone();
        if (url.pathname === "/" || url.pathname === "/analytics") {
          url.pathname = "/analytics";
          url.searchParams.set("client", slug);
          return NextResponse.rewrite(url);
        }
        if (url.pathname === "/qc-brain") {
          url.pathname = `/qc-brain/${slug}`;
          return NextResponse.rewrite(url);
        }
      }
    }
  }
  return NextResponse.next();
}

export const config = {
  // Runs on everything except Next's own assets and static files. The auth check inside re-admits the login
  // page, the auth endpoints and the machine routes, so the whole policy is decided in one place above.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|jpe?g|gif|svg|webp|ico|css|js|map|woff2?|ttf)).*)"],
};
