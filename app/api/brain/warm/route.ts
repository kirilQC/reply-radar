/**
 * Laying out every document in the brain, without anybody opening it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * The layout was built as something that happens when a reader arrives, which is correct behaviour and
 * a bad experience: the first person to open a client's ICP waits half a minute for it, and a document
 * nobody has opened yet has no layout at all — so the one time it matters, when somebody is looking
 * for something in a hurry, is exactly when they get the wall of text. Worse, the backlog grows on its
 * own. Folders and files are added to this repository every week; if generation only ever happens on a
 * visit then staying ahead means remembering to visit every new page.
 *
 * So the walk lives here instead. It works out its own backlog, renders as much of it as one
 * invocation can afford, and reports what is left. Nothing about it is specific to a client or a
 * folder, which is the point: whatever gets committed to the brain is picked up by the next pass.
 *
 * ── How it knows what needs doing ───────────────────────────────────────────────────────────────
 * The GitHub tree listing already carries every blob's SHA, and the store already keys layouts by the
 * SHA they were made from. So the backlog is a set subtraction over two requests — no file is fetched
 * unless it is about to be laid out. A document whose text has not changed since it was laid out costs
 * nothing here, for ever, which is what makes running this on a schedule affordable.
 *
 * ── Why it stops before it is finished ──────────────────────────────────────────────────────────
 * A render is a model call of up to a couple of minutes and there are hundreds of documents, so no
 * single invocation can clear the list — a serverless function that tried would be killed halfway and
 * the work in flight would be lost. Instead it works to a deadline comfortably inside the platform's
 * limit, then returns `remaining`. The caller comes back. That makes progress durable at the row level:
 * every document that finished is saved, whatever happens to the invocation carrying it.
 */
import { NextResponse } from "next/server";
import { brainConfigured, brainFile, brainTree } from "../../../lib/brain";
import { renderBrainDoc, storedRenderShas } from "../../../lib/brain-render";
import { fileKind } from "../../../../shared/brain-structure.mjs";

export const maxDuration = 300;

/**
 * When to stop taking new documents on.
 *
 * Well inside the 300s ceiling, because the check happens before a render starts and a long one can
 * still run for the best part of three minutes after passing it. Overshooting the platform limit does
 * not just lose that document — it loses the response, so the caller never learns what is left.
 */
const DEADLINE_MS = 150_000;

/**
 * How many at once.
 *
 * Three is a compromise between wall-clock time and the two rate limits either side of this: the
 * Anthropic account is shared with the MCP chat that somebody may be using right now, and a burst of
 * a dozen renders would make their answer crawl. It also keeps the failure blast radius small — a
 * repository-wide walk that trips a rate limit converts every document it touches into an error row.
 */
const WORKERS = 3;

/** Documents only. A CSV of leads or a PNG has no prose to lay out and would burn a call finding out. */
const layoutable = (path: string, size: number) => fileKind(path) === "doc" && size > 400;

/**
 * A pass over the repository.
 *
 * GET so a scheduler can call it, POST so the app can. Both do the same thing, and both are safe to
 * call twice: the second one finds the first one's rows and does the rest.
 *
 * `?check=1` reports the backlog without spending anything, which is what lets a page show progress
 * without becoming the thing that drives it.
 */
async function walk(request: Request) {
  if (!brainConfigured()) {
    return NextResponse.json({ ok: false, error: "The QC Brain is not connected. Set BRAIN_GITHUB_TOKEN." }, { status: 503 });
  }

  const params = new URL(request.url).searchParams;
  const checking = params.get("check") === "1";

  try {
    const [files, stored] = await Promise.all([brainTree(), storedRenderShas()]);
    const documents = files.filter((file) => layoutable(file.path, file.size));
    const behind = documents.filter((file) => stored.get(file.path) !== file.sha);

    if (checking) {
      return NextResponse.json({ ok: true, documents: documents.length, remaining: behind.length, rendered: 0, failed: [] });
    }

    const started = Date.now();
    const queue = [...behind];
    const failed: { path: string; error: string }[] = [];
    let rendered = 0;

    await Promise.all(
      Array.from({ length: Math.min(WORKERS, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
          if (Date.now() - started > DEADLINE_MS) {
            // Put it back, so what is reported as remaining is the truth rather than one short.
            queue.unshift(next);
            return;
          }
          try {
            const doc = await brainFile(next.path);
            // The SHA from the file read, not from the tree: they are the same until somebody commits
            // between the two, and a row keyed by the wrong one would be a layout of text nobody has.
            await renderBrainDoc({ path: next.path, text: doc.text, sha: doc.sha });
            rendered += 1;
          } catch (error) {
            // One unreadable document must not end the walk. It is named in the response so a
            // repeatedly failing file is findable rather than a silently permanent gap.
            failed.push({ path: next.path, error: error instanceof Error ? error.message : "Could not be laid out." });
          }
        }
      }),
    );

    return NextResponse.json({
      ok: true,
      documents: documents.length,
      rendered,
      // What this pass did not get to. Documents that failed are not counted here, or a caller looping
      // until the number reaches zero would loop for ever over the same broken file; `rendered` being
      // zero is the signal that another pass would achieve nothing.
      remaining: queue.length,
      failed: failed.slice(0, 20),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "The brain could not be walked." },
      { status: 502 },
    );
  }
}

export const GET = walk;
export const POST = walk;
