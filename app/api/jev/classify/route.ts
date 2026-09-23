// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Classify one chunk of contacts, streaming each verdict back the moment Jev answers it.
 *
 * ── Why the browser sends chunks rather than the file ────────────────────────────────────────────
 * A 5,000-row export is ~30MB — past Vercel's request-body limit — and one request for all of it would blow
 * the 60-second function ceiling. The browser parses the file, trims each row to its profile, and sends a few
 * dozen profiles per request, several requests at once. Each request finishes in seconds.
 *
 * ── Why NDJSON ───────────────────────────────────────────────────────────────────────────────────
 * One line per contact, written as soon as that contact's answer lands, so the table fills row by row instead
 * of in lumps of forty.
 *
 * ── Why the verdict is computed here ─────────────────────────────────────────────────────────────
 * The saved question set is read once per request and the verdict is applied against it on the server, so
 * what a run decides is always what Supabase holds — never an unsaved edit sitting in a browser tab.
 */
import { evaluateOne, loadQuestionSet } from "../../../lib/jev";
import { verdictFor } from "../../../../shared/jev.mjs";

export const maxDuration = 60;

const MAX_ROWS_PER_REQUEST = 100;
/** Requests in flight per chunk. The browser runs a few chunks at once, so the real total is a multiple. */
const CONCURRENCY = 12;

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const slug = typeof body?.client === "string" ? body.client.trim().toLowerCase() : "";
  const rows = Array.isArray(body?.rows) ? (body.rows as Array<{ i: number; state: unknown }>).slice(0, MAX_ROWS_PER_REQUEST) : [];
  if (!slug || !rows.length) return Response.json({ ok: false, error: "client and rows are required." }, { status: 400 });

  let set;
  try { set = await loadQuestionSet(slug); } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "Could not read the question set." }, { status: 502 });
  }
  if (!set?.questions.length) return Response.json({ ok: false, error: "This client has no saved question set." }, { status: 409 });
  const { questions, thresholds } = set;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let next = 0;
      const worker = async () => {
        while (next < rows.length) {
          const row = rows[next++];
          const result = await evaluateOne(row.state, questions);
          const line = result.ok
            ? { i: row.i, ok: true, ...verdictFor(questions, result.answers, thresholds), tokens: result.tokens ?? 0, cost: result.cost ?? null }
            : { i: row.i, ok: false, error: result.error, status: result.status ?? 0 };
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
