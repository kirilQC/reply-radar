// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The client's ICP document, written from their whole folder.
 *
 * A POST because it spends a couple of minutes and real money, and because there is nothing to cache:
 * unlike the reading layer, which is a stable transformation of one file and is keyed by that file's
 * SHA, this is a document somebody asked for now and will read once. Two of them a week is not a cache
 * problem, and a stale one silently served would be worse than the wait.
 *
 * Core documents lead the transcript in slot order — brief, then ICP, then personas — because that is
 * the order in which they answer "who is this", and a model reading the folder alphabetically would
 * meet twelve call notes before the brief.
 */
import { NextResponse } from "next/server";
import { brainConfigured, brainFiles, brainTree, writeBrainFile } from "../../../lib/brain";
import { ICP_MAX_CHUNKS, icpDocPrompt, writeIcpDoc } from "../../../lib/brain-icp";
import { workspacesByFolder, type BrainWorkspace } from "../../../lib/brain-workspaces";
import { clientLabel, clientSkeleton, fileKind } from "../../../../shared/brain-structure.mjs";

/**
 * Sixty, not three hundred. A plan that does not allow a longer function does not fail the request, it
 * clamps the ceiling and kills the work at sixty seconds — which is exactly what was happening, and is
 * why the button appeared to do nothing at all. The writing is chunked to fit well inside this, and the
 * page comes back for the rest.
 */
export const maxDuration = 60;

type Skeleton = { client: string; label: string; docs: { found: string; present: boolean }[]; extras: string[] };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const client = typeof body.client === "string" ? body.client.trim() : "";
  /** The document as it stands. Empty on the first request, and the model's own text after that. */
  const sofar = typeof body.sofar === "string" ? body.sofar : "";
  /** Free-text instructions from the user's chatbox — what to include, cut, shorten, emphasise. */
  const guidance = typeof body.guidance === "string" ? body.guidance.trim().slice(0, 2000) : "";
  const chunk = Number.isFinite(Number(body.chunk)) ? Math.max(0, Math.floor(Number(body.chunk))) : 0;
  if (chunk >= ICP_MAX_CHUNKS) {
    return NextResponse.json({ ok: false, error: "That document did not finish in a reasonable number of passes." }, { status: 400 });
  }

  if (!client) return NextResponse.json({ ok: false, error: "No client was asked for." }, { status: 400 });
  if (client.includes("/") || client.includes("..")) {
    return NextResponse.json({ ok: false, error: "That is not a client folder." }, { status: 400 });
  }
  if (!brainConfigured()) {
    return NextResponse.json({ ok: false, error: "The QC Brain is not connected. Set BRAIN_GITHUB_TOKEN." }, { status: 503 });
  }

  try {
    const paths = (await brainTree()).map((file) => file.path);
    const skeleton = clientSkeleton(client, paths) as Skeleton;
    const wanted = [...skeleton.docs.filter((doc) => doc.present).map((doc) => doc.found), ...skeleton.extras].filter(
      (path) => fileKind(path) === "doc",
    );
    if (!wanted.length) {
      return NextResponse.json({ ok: false, error: `There is nothing written about ${client} in the brain yet.` }, { status: 404 });
    }

    const [prompt, docs, linked] = await Promise.all([
      icpDocPrompt(),
      brainFiles(wanted, 6),
      workspacesByFolder([skeleton.client]).catch(() => new Map<string, BrainWorkspace>()),
    ]);
    // `brainFiles` returns whatever it managed to read, in whatever order the workers finished. The
    // requested order is the meaningful one, so it is restored here rather than relied upon there.
    const byPath = new Map(docs.map((doc) => [doc.path, doc.text]));
    const sources = wanted.filter((path) => byPath.has(path)).map((path) => ({ path, text: byPath.get(path) ?? "" }));

    const label = linked.get(skeleton.client)?.name || skeleton.label || String(clientLabel(client));
    // The user's own instructions ride at the end of the system prompt, where they take precedence over the
    // house defaults — so "make it two pages", "drop the exclusions", "lead with the triggers" all take effect.
    const finalPrompt = guidance
      ? `${prompt}\n\n## Instructions from the person requesting this document — follow these over the defaults above\n${guidance}`
      : prompt;
    const written = await writeIcpDoc({ label, sources, prompt: finalPrompt, sofar });

    // The whole point: once the document is finished, write it into the client's brain folder. `written.markdown`
    // is the full accumulated document (sofar + this chunk), so the last pass carries the complete text. The
    // ICP slot's canonical path is account/icp.md under the client folder. A save failure does not fail the
    // request — the page still shows the document — but its URL is returned so the user gets a link to the file.
    let savedUrl: string | null = null;
    if (written.done) {
      const icpPath = skeleton.docs[1]?.found || `clients/${skeleton.client}/account/icp.md`;
      try {
        const saved = await writeBrainFile({ path: icpPath, text: written.markdown, summary: `ICP document for ${label}`, author: "Reply Radar" });
        savedUrl = saved.url;
      } catch {
        /* the document is still shown; only the write-back to the repo failed */
      }
    }

    return NextResponse.json({
      ok: true,
      client: skeleton.client,
      label,
      ...written,
      savedUrl,
      // How many more times the page may come back before it should stop asking. Counted here so the
      // limit lives with the thing that knows what a request costs.
      chunk: chunk + 1,
      more: !written.done && chunk + 1 < ICP_MAX_CHUNKS,
      sources: sources.map((source) => source.path),
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "That document could not be written." },
      { status: 502 },
    );
  }
}
