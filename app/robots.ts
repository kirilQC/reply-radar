// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import type { MetadataRoute } from "next";

/**
 * Nothing here is for the public web.
 *
 * This app answers on a real domain with no sign-in, and every page on it is a client's inbox, a
 * client's lead list or a client's reporting. Without this file the first crawler to find
 * `replyradar.dev` would index all of it, and the leak would not be the crawl — it would be the
 * search result that outlives it, sitting in Google's cache under a client's name with nobody
 * having done anything wrong.
 *
 * `Disallow: /` is a request, not a wall; a crawler that ignores it still gets in, exactly as
 * anyone with the URL does. It is here because the well-behaved crawlers are the ones that cause
 * this particular kind of harm, and they are the ones that read this.
 */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
