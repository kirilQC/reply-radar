// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Scraping for the Jev pipeline.
 *
 * - `POST {mode: "companies", items: [{i, url}]}` reads each company website and streams one NDJSON line per
 *   site as it finishes. Kept to a dozen sites a request: each read can take up to ~16s (homepage + About page),
 *   and the batch has to finish inside the 60s function ceiling.
 * - `POST {mode: "contacts", urls}` starts a Bright Data batch and returns its snapshot id at once.
 * - `GET ?snapshot=<id>` collects that batch: `ready: false` until Bright Data has finished.
 */
import { collectProfiles, readWebsite, triggerProfiles } from "../../../lib/enrich";
import { linkedinProfileUrl, websiteUrl } from "../../../../shared/enrich.mjs";

export const maxDuration = 60;

const MAX_SITES = 12;
const SITE_CONCURRENCY = 12;
/** Bright Data blacklists an IP that starts too many jobs, so contact batches are big and few. */
const MAX_PROFILES = 1_000;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (body?.mode === "contacts") {
    const urls = [...new Set((Array.isArray(body?.urls) ? body.urls : []).map((u: unknown) => linkedinProfileUrl(u)).filter(Boolean))].slice(0, MAX_PROFILES) as string[];
    if (!urls.length) return Response.json({ ok: false, error: "No LinkedIn profile URLs to scrape." }, { status: 400 });
    const result = await triggerProfiles(urls);
    return Response.json({ ...result, count: urls.length }, { status: result.ok ? 200 : 502 });
  }
  const items = (Array.isArray(body?.items) ? body.items : []).slice(0, MAX_SITES) as Array<{ i: number; url: string }>;
  if (!items.length) return Response.json({ ok: false, error: "items are required." }, { status: 400 });
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const item = items[next++];
          const url = websiteUrl(item.url);
          const line = url ? { i: item.i, ...(await readWebsite(url)) } : { i: item.i, ok: false, url: item.url, error: "not a website address" };
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        }
      };
      await Promise.all(Array.from({ length: Math.min(SITE_CONCURRENCY, items.length) }, worker));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}

export async function GET(request: Request) {
  const snapshot = new URL(request.url).searchParams.get("snapshot") ?? "";
  const result = await collectProfiles(snapshot);
  return Response.json(result, { status: result.ok ? 200 : 502 });
}
