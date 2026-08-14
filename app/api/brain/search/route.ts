// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Search across the whole brain.
 *
 * The first request after a cold start pulls every markdown file into memory, which takes a few
 * seconds; every request after that is instant and works on the exact current text rather than on
 * whatever GitHub's code index last saw. The reasoning for that trade is in `brainCorpus`.
 *
 * Results carry the client they belong to, because "which client is this about" is the first thing
 * anyone asks of a search result in this repo and the path does not read as an answer at a glance.
 */
import { NextResponse } from "next/server";
import { BRAIN_URL, brainConfigured, brainCorpus, brainTree } from "../../../lib/brain";
import { clientLabel, clientOf, fileTitle, isReadable } from "../../../../shared/brain-structure.mjs";
import { searchBrain } from "../../../../shared/brain-search.mjs";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!query) return NextResponse.json({ ok: true, query: "", results: [], searched: 0 });
  if (!brainConfigured()) {
    return NextResponse.json({ ok: false, error: "The QC Brain is not connected. Set BRAIN_GITHUB_TOKEN." }, { status: 503 });
  }

  try {
    const files = await brainTree();
    const readable = files.map((file) => file.path).filter(isReadable);
    const docs = await brainCorpus(readable);
    const results = searchBrain(
      docs.map((doc) => ({ path: doc.path, text: doc.text, title: fileTitle(doc.path) })),
      query,
    ).map((hit: { path: string; score: number; snippet: string }) => {
      const client = clientOf(hit.path);
      return {
        path: hit.path,
        title: fileTitle(hit.path),
        snippet: hit.snippet,
        client,
        clientLabel: client ? clientLabel(client) : "",
        url: `${BRAIN_URL}/blob/main/${hit.path}`,
      };
    });
    return NextResponse.json({ ok: true, query, results, searched: docs.length });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "The search could not run." },
      { status: 502 },
    );
  }
}
