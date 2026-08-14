/**
 * The index of the QC Brain: every client, what context exists for them, and what does not.
 *
 * ── What this is answering ─────────────────────────────────────────────────────────────────────
 * Not "what files are in this repo" — GitHub already answers that, and answering it again with nicer
 * fonts would be pointless. The question this answers is "is this client written up well enough for
 * anyone to work on them", which nobody can answer today without opening seventeen folders and
 * remembering what a complete one looks like.
 *
 * That is why the response is shaped as a fixed skeleton per client rather than a file listing. A
 * missing ICP is the most useful thing on the page and it cannot be shown by listing what is there.
 *
 * ── Why one client's detail comes from the same route ──────────────────────────────────────────
 * `?client=willow` returns that one client's full skeleton, its other files grouped by folder, and
 * when each of its core documents was last touched. Dating a file is one GitHub request per file, so
 * dating the whole index would be a hundred and twenty requests to draw one page — the index gets
 * none, and the client page gets seven. The tree is already cached, so the second call is nearly
 * free, and sharing the route keeps one definition of what a client is.
 */
import { NextResponse } from "next/server";
import { BRAIN_URL, brainConfigured, brainLastTouched, brainTree } from "../../../lib/brain";
import { BRAIN_AREAS, clientSkeleton, clientsIn, coverage, fileTitle, groupByFolder } from "../../../../shared/brain-structure.mjs";

type Skeleton = {
  client: string;
  label: string;
  docs: { key: string; label: string; blurb: string; found: string; present: boolean }[];
  extras: string[];
  groups: { folder: string; files: { path: string; name: string }[] }[];
};

export async function GET(request: Request) {
  if (!brainConfigured()) {
    // A specific instruction, not a generic failure. This is the one setup step the feature needs and
    // whoever hits this screen is the person who can do it.
    return NextResponse.json(
      {
        ok: false,
        repoUrl: BRAIN_URL,
        error: "The QC Brain is not connected yet. Add BRAIN_GITHUB_TOKEN in Vercel — a GitHub token with read access to the repo.",
      },
      { status: 503 },
    );
  }

  try {
    const files = await brainTree();
    const paths = files.map((file) => file.path);
    const params = new URL(request.url).searchParams;
    const only = params.get("client")?.trim() ?? "";
    const area = params.get("area")?.trim() ?? "";

    // The parts of the repo that are not clients — process, playbooks, vertical research. Grouped by
    // folder for the same reason a client's extras are: thirty loose filenames is the file tree again.
    if (area) {
      const known = BRAIN_AREAS.find((entry: { prefix: string }) => entry.prefix === area);
      if (!known) return NextResponse.json({ ok: false, error: "That is not an area of the brain." }, { status: 400 });
      const inside = paths.filter((path) => path.startsWith(area));
      return NextResponse.json({
        ok: true,
        repoUrl: BRAIN_URL,
        area: {
          ...known,
          groups: (groupByFolder(inside, area) as { folder: string; files: { path: string; name: string }[] }[]).map((group) => ({
            folder: group.folder,
            files: group.files.map((file) => ({ ...file, title: fileTitle(file.path) })),
          })),
        },
      });
    }

    if (only) {
      const skeleton = clientSkeleton(only, paths) as Skeleton;
      if (!skeleton.docs.some((doc) => doc.present) && !skeleton.extras.length) {
        return NextResponse.json({ ok: false, error: `There is nothing under clients/${only} in the brain.` }, { status: 404 });
      }
      const touched = await brainLastTouched(skeleton.docs.map((doc) => doc.found).filter(Boolean));
      return NextResponse.json({
        ok: true,
        repoUrl: BRAIN_URL,
        client: {
          client: skeleton.client,
          label: skeleton.label,
          docs: skeleton.docs.map((doc) => ({
            key: doc.key,
            label: doc.label,
            blurb: doc.blurb,
            path: doc.found,
            present: doc.present,
            updated: touched.get(doc.found) ?? "",
          })),
          groups: skeleton.groups.map((group) => ({
            folder: group.folder,
            files: group.files.map((file) => ({ ...file, title: fileTitle(file.path) })),
          })),
          coverage: coverage(skeleton),
        },
      });
    }

    const clients = clientsIn(paths).map((client: string) => {
      const skeleton = clientSkeleton(client, paths) as Skeleton;
      return {
        client: skeleton.client,
        label: skeleton.label,
        docs: skeleton.docs.map((doc) => ({ key: doc.key, label: doc.label, blurb: doc.blurb, path: doc.found, present: doc.present })),
        files: skeleton.extras.length + skeleton.docs.filter((doc) => doc.present).length,
        coverage: coverage(skeleton),
      };
    });

    const areas = BRAIN_AREAS.map((area: { key: string; label: string; prefix: string; blurb: string }) => ({
      ...area,
      files: paths.filter((path) => path.startsWith(area.prefix)).length,
    }));

    return NextResponse.json({ ok: true, repoUrl: BRAIN_URL, clients, areas, total: paths.length });
  } catch (error) {
    return NextResponse.json(
      { ok: false, repoUrl: BRAIN_URL, error: error instanceof Error ? error.message : "The QC Brain could not be read." },
      { status: 502 },
    );
  }
}
