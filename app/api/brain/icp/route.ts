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
import { brainConfigured, brainFiles, brainTree } from "../../../lib/brain";
import { icpDocPrompt, writeIcpDoc } from "../../../lib/brain-icp";
import { workspacesByFolder, type BrainWorkspace } from "../../../lib/brain-workspaces";
import { clientLabel, clientSkeleton, fileKind } from "../../../../shared/brain-structure.mjs";

export const maxDuration = 300;

type Skeleton = { client: string; label: string; docs: { found: string; present: boolean }[]; extras: string[] };

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const client = typeof body.client === "string" ? body.client.trim() : "";

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
    const written = await writeIcpDoc({ label, sources, prompt });
    return NextResponse.json({ ok: true, client: skeleton.client, label, ...written, sources: sources.map((source) => source.path) });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "That document could not be written." },
      { status: 502 },
    );
  }
}
