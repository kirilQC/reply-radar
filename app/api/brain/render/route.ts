// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The readable layout of one brain document.
 *
 * A POST rather than a GET because the first call for a given version of a file spends money and half
 * a minute; that is not a thing to put behind a cacheable, prefetchable, retried-by-anything verb.
 * Every call after it is a single indexed row lookup — see `app/lib/brain-render.ts` for why the cache
 * is keyed on the file's git SHA.
 *
 * Nothing here writes to the brain repository. The layout is Reply Radar's, the file is GitHub's, and
 * the only thing that reaches GitHub is still a pull request somebody merged.
 */
import { NextResponse } from "next/server";
import { brainConfigured, brainFile } from "../../../lib/brain";
import { renderBrainDoc } from "../../../lib/brain-render";
import { fileKind } from "../../../../shared/brain-structure.mjs";

/**
 * Sixty, which is the ceiling this account actually has. `300` asks for something the plan does not
 * sell and is quietly clamped rather than refused, so declaring it only made the real limit invisible.
 * The model call is bounded inside this so a document too long to lay out returns an error the reader
 * can see, instead of the invocation dying with nothing written.
 */
export const maxDuration = 60;

type Row = Record<string, unknown>;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Row;
  const path = typeof body.path === "string" ? body.path.trim() : "";
  const force = body.force === true;

  if (!path) return NextResponse.json({ ok: false, error: "No file was asked for." }, { status: 400 });
  if (path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ ok: false, error: "That is not a path in this repository." }, { status: 400 });
  }
  if (fileKind(path) !== "doc") {
    return NextResponse.json({ ok: false, error: "Only documents can be laid out." }, { status: 400 });
  }
  if (!brainConfigured()) {
    return NextResponse.json({ ok: false, error: "The QC Brain is not connected. Set BRAIN_GITHUB_TOKEN." }, { status: 503 });
  }

  try {
    // Read from the brain rather than trusting text posted from the browser. The page has the document
    // in hand and sending it would save a request, but then the layout is of whatever was posted — and
    // a cache keyed by a SHA the server did not verify is a cache of somebody else's text.
    const doc = await brainFile(path);
    const render = await renderBrainDoc({ path, text: doc.text, sha: doc.sha, force });
    return NextResponse.json({ ok: true, render });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "That document could not be laid out." },
      { status: 502 },
    );
  }
}
