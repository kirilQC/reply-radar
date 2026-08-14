// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * One document out of the brain, with everything the page needs to render and edit it.
 *
 * The SHA travels with the text and comes back on save. That is not incidental — it is what makes
 * two people editing the same client brief safe, because GitHub refuses the second write if the file
 * moved underneath it. Dropping the SHA here would turn a conflict into a silent overwrite.
 *
 * Campaign codes are extracted server-side rather than in the browser because the page needs to fetch
 * the matching campaign data anyway, and finding out what to fetch after the render is a second
 * round trip for something the server already had in hand.
 */
import { NextResponse } from "next/server";
import { BRAIN_URL, brainConfigured, brainFile, brainLastTouched } from "../../../lib/brain";
import { campaignCodesIn, fileKind, fileTitle } from "../../../../shared/brain-structure.mjs";

export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path")?.trim() ?? "";
  if (!path) return NextResponse.json({ ok: false, error: "No file was asked for." }, { status: 400 });
  // A path is a key into one repo, not a filesystem walk. `..` is refused rather than normalised
  // because there is no legitimate request that contains it.
  if (path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ ok: false, error: "That is not a path in this repository." }, { status: 400 });
  }
  if (!brainConfigured()) {
    return NextResponse.json({ ok: false, error: "The QC Brain is not connected. Set BRAIN_GITHUB_TOKEN." }, { status: 503 });
  }
  if (fileKind(path) !== "doc") {
    // Everything that is not markdown is linked rather than opened — a CSV of four thousand leads or
    // a JSONL scrape is not a reading surface, and pretending otherwise wastes a page load.
    return NextResponse.json({
      ok: true,
      path,
      kind: fileKind(path),
      title: fileTitle(path),
      text: "",
      sha: "",
      url: `${BRAIN_URL}/blob/main/${path}`,
      codes: [],
      updated: "",
    });
  }

  try {
    const doc = await brainFile(path);
    const touched = await brainLastTouched([path]);
    return NextResponse.json({
      ok: true,
      path: doc.path,
      kind: "doc",
      title: fileTitle(path),
      text: doc.text,
      sha: doc.sha,
      url: doc.url,
      codes: campaignCodesIn(doc.text),
      updated: touched.get(path) ?? "",
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "That file could not be read." },
      { status: 502 },
    );
  }
}
