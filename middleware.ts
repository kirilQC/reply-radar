// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse, type NextRequest } from "next/server";

/**
 * Gives every client a subdomain: `acme.example.com` is rewritten to `/analytics?client=acme`, and
 * `acme.example.com/qc-brain` to that client's page in the QC Brain. Requires a wildcard
 * `*.<root domain>` DNS record pointing at the deployment plus the wildcard domain added in Vercel;
 * until then the equivalent `/analytics?client=<slug>` and `/qc-brain/<slug>` paths work unchanged,
 * which is why the rewrite is a shortcut to a real URL rather than the only way to reach one.
 *
 * ROOT_DOMAIN (e.g. "replyradar.app") tells the rewrite which leading label is the client.
 */
const RESERVED = new Set(["www", "app", "api", "admin", "vercel", "localhost"]);

export function middleware(request: NextRequest) {
  const rootDomain = process.env.ROOT_DOMAIN?.trim().toLowerCase();
  if (!rootDomain) return NextResponse.next();

  const host = (request.headers.get("host") ?? "").split(":")[0].toLowerCase();
  if (host === rootDomain || !host.endsWith(`.${rootDomain}`)) return NextResponse.next();

  const slug = host.slice(0, -(rootDomain.length + 1));
  // Only a single leading label is a client slug; anything deeper is left alone.
  if (!slug || slug.includes(".") || RESERVED.has(slug)) return NextResponse.next();

  const url = request.nextUrl.clone();
  if (url.pathname === "/" || url.pathname === "/analytics") {
    url.pathname = "/analytics";
    url.searchParams.set("client", slug);
    return NextResponse.rewrite(url);
  }
  // The brain's directory on a client's own subdomain means that client, not the wall of everyone.
  // The slug here is the workspace slug; the page resolves it to a brain folder through the tether,
  // because the two names agree for most clients and quietly disagree for some.
  if (url.pathname === "/qc-brain") {
    url.pathname = `/qc-brain/${slug}`;
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/analytics", "/qc-brain"],
};
