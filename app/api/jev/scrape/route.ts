// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The "get more data" step of the Jev pipeline. Both modes stream one NDJSON line per row as it resolves.
 *
 * - `{mode: "companies", items: [{i, url}]}` reads each company's own website — a dozen a request, because one
 *   read can take ~16s (home + About) and the batch must finish inside the 60s function ceiling.
 * - `{mode: "contacts", items: [{i, url}]}` looks the LinkedIn URLs up in AI Ark, a hundred a request in a single
 *   People Search call. Rows AI Ark does not know come back `ok: false` and cost nothing.
 */
import { lookupContacts, readWebsite } from "../../../lib/enrich";
import { normalizeLinkedIn } from "../../../lib/ai-ark-enrichment";
import { linkedinProfileUrl, websiteUrl } from "../../../../shared/enrich.mjs";

export const maxDuration = 60;

const MAX_SITES = 12;
const SITE_CONCURRENCY = 12;
const MAX_PEOPLE = 100;

const ndjson = (lines: unknown[]) => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (body?.mode === "contacts") {
    const items = (Array.isArray(body?.items) ? body.items : []).slice(0, MAX_PEOPLE) as Array<{ i: number; url: string }>;
    const rows = items.map((it) => ({ i: it.i, url: linkedinProfileUrl(it.url) })).filter((r) => r.url);
    if (!rows.length) return Response.json({ ok: false, error: "No LinkedIn profile URLs to look up." }, { status: 400 });
    const result = await lookupContacts(rows.map((r) => r.url));
    if (!result.ok) {
      const status = /AI_ARK_API_KEY/.test(result.error ?? "") ? 409 : 502;
      if (status === 409) return Response.json({ ok: false, error: result.error }, { status });
      return ndjson(rows.map((r) => ({ i: r.i, ok: false, url: r.url, error: result.error })));
    }
    return ndjson(rows.map((r) => {
      const person = result.found.get(normalizeLinkedIn(r.url));
      return person ? { i: r.i, ok: true, url: r.url, person } : { i: r.i, ok: false, url: r.url, error: "not in AI Ark" };
    }));
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
