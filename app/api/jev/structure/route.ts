// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Structure a batch of scraped sources into Jev's fields in one model call. Answers stream back as NDJSON, one
 * line per row, so the pipeline reads this exactly like the other stages. A rate limit comes back as a single
 * `{ rateLimited: true, retryAfterMs }` line: the browser holds the batch and resends it, rather than failing
 * every row in it.
 */
import { structureBatch } from "../../../lib/enrich";


export const maxDuration = 60;

const MAX_ITEMS = 8;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const mode = body?.mode === "companies" ? "companies" : "contacts";
  const items = (Array.isArray(body?.items) ? body.items : []).slice(0, MAX_ITEMS) as Array<{ i: number; profile: unknown; source: Record<string, unknown> }>;
  if (!items.length) return Response.json({ ok: false, error: "items are required." }, { status: 400 });
  const result = await structureBatch(mode, items);
  const lines: unknown[] = [];
  if (result.ok) {
    const share = result.cost != null ? result.cost / items.length : null;
    for (const it of items) {
      const structured = result.rows.get(it.i);
      lines.push(structured ? { i: it.i, ok: true, structured, cost: share, model: result.model } : { i: it.i, ok: false, error: "The model left this row out of its answer." });
    }
  } else if (result.rateLimited) {
    lines.push({ rateLimited: true, retryAfterMs: result.retryAfterMs, error: result.error });
  } else {
    for (const it of items) lines.push({ i: it.i, ok: false, error: result.error });
  }

  return new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
