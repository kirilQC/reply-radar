// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Proposing a change to the brain.
 *
 * ── Why this opens a pull request instead of saving ─────────────────────────────────────────────
 * Every person at QC has their Claude Code pointed at this repository, so an edit here is not one
 * person's document being wrong — it becomes the shared truth everyone's assistant answers from, and
 * a wrong ICP does not announce itself. A pull request costs one click to merge and makes the change
 * reviewable, attributable and revertible. The screen says "propose" because that is honestly what is
 * happening, and calling it "save" would be a lie about where the text ends up.
 *
 * ── The SHA ────────────────────────────────────────────────────────────────────────────────────
 * Sent back exactly as it came out of the read. GitHub refuses the write if the file has moved since,
 * which is the only thing preventing two people from silently overwriting each other. That refusal is
 * surfaced as "someone else changed this", not as a failure.
 */
import { NextResponse } from "next/server";
import { brainConfigured, forgetBrainTree, proposeBrainEdit } from "../../../lib/brain";
import { fileKind } from "../../../../shared/brain-structure.mjs";

export async function POST(request: Request) {
  if (!brainConfigured()) {
    return NextResponse.json({ ok: false, error: "The QC Brain is not connected. Set BRAIN_GITHUB_TOKEN." }, { status: 503 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const path = String(body.path ?? "").trim();
  const text = String(body.text ?? "");
  const sha = String(body.sha ?? "").trim();
  const summary = String(body.summary ?? "").trim();
  const author = String(body.author ?? "").trim();

  if (!path || path.includes("..") || path.startsWith("/")) {
    return NextResponse.json({ ok: false, error: "That is not a path in this repository." }, { status: 400 });
  }
  if (fileKind(path) !== "doc") {
    // Editing a CSV of leads or a JSONL scrape as text is a way to corrupt it, not a feature.
    return NextResponse.json({ ok: false, error: "Only markdown documents can be edited here." }, { status: 400 });
  }
  if (!summary) {
    // The summary becomes the commit message and the pull request title, so it is the only thing a
    // reviewer sees before they open the diff. An empty one makes the review list unreadable.
    return NextResponse.json({ ok: false, error: "Say what changed — it becomes the title of the pull request." }, { status: 400 });
  }
  if (!text.trim()) {
    return NextResponse.json({ ok: false, error: "The document is empty. Deleting a file is done in GitHub, deliberately." }, { status: 400 });
  }

  try {
    const pull = await proposeBrainEdit({ path, text, sha, summary, author: author || "QC Brain" });
    forgetBrainTree();
    return NextResponse.json({ ok: true, ...pull });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "The change could not be proposed." },
      { status: 502 },
    );
  }
}
