import { NextResponse, type NextRequest } from "next/server";

/**
 * Gives every client a subdomain for their analytics page: `acme.example.com` is rewritten
 * to `/analytics?client=acme`. Requires a wildcard `*.<root domain>` DNS record pointing at
 * the deployment plus the wildcard domain added in Vercel; until then the equivalent
 * `/analytics?client=<slug>` path keeps working unchanged.
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
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/analytics"],
};
