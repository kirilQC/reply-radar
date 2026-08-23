// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

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
import { BRAIN_URL, brainClientActivity, brainConfigured, brainFile, brainLastTouched, brainTree } from "../../../lib/brain";
import { workspacesByFolder, type BrainWorkspace } from "../../../lib/brain-workspaces";
import { BRAIN_AREAS, briefSummary, clientLabel, clientLogoIn, clientSkeleton, clientsIn, coverage, fileTitle, groupByFolder } from "../../../../shared/brain-structure.mjs";

/**
 * A logo the browser can actually load, or nothing.
 *
 * Reply Radar's own copy first — every client set up here already has one, uploaded through the
 * admin console, and it is already in the row this route read. A committed `logo.*` in the repo is
 * the fallback and has to be proxied, because the repo is private and an `<img src>` has no token.
 */
const logoFor = (client: string, paths: string[], workspace?: BrainWorkspace) => {
  if (workspace?.logo) return workspace.logo;
  const found = String(clientLogoIn(paths, client));
  return found ? `/api/brain/logo?path=${encodeURIComponent(found)}` : "";
};

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
        error:
          "The QC Brain is not connected yet. Add BRAIN_GITHUB_TOKEN in Vercel — a GitHub token with Contents and Pull requests access to the repo — and then redeploy, because Vercel only gives a new variable to a new deployment.",
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
      // The brief's opening paragraph, so the page can say who this client is before anyone opens
      // anything. One extra file fetch, cached like every other, and only on a client's own page.
      const briefPath = skeleton.docs.find((doc) => doc.key === "brief" && doc.present)?.found ?? "";
      const folderNames = clientsIn(paths) as string[];
      // The client's own slash commands used to be read here for a row of chips on their page. They
      // came off the page — a routine is something you run in Claude Code, and a chip that opens the
      // markdown behind it was not what anybody wanted from it — so three file reads per client page
      // came off with them. Every command is still listed under Skills.
      const [touched, linked, brief, activity] = await Promise.all([
        brainLastTouched(skeleton.docs.map((doc) => doc.found).filter(Boolean)),
        workspacesByFolder(folderNames),
        briefPath ? brainFile(briefPath).catch(() => null) : Promise.resolve(null),
        brainClientActivity(skeleton.client).catch(() => ({ latestItem: "", latestDate: "", since: "" })),
      ]);
      const workspace = linked.get(skeleton.client);
      const { summary, facts } = briefSummary(brief?.text ?? "") as { summary: string; facts: { label: string; value: string }[] };
      return NextResponse.json({
        ok: true,
        repoUrl: BRAIN_URL,
        client: {
          client: skeleton.client,
          label: skeleton.label,
          logo: logoFor(skeleton.client, paths, workspace),
          summary,
          facts,
          briefPath,
          // What changed last and how long we have held this client — two facts the file tree cannot
          // carry, read from the folder's commit history.
          activity,
          // The other half of this client. Named on the page so somebody can tell a client we run
          // campaigns for from a prospect we only ever wrote notes about — a distinction the brain
          // alone cannot make, and the reason for tethering the two systems at all.
          workspace: workspace
            ? { name: workspace.name, slug: workspace.slug, connected: workspace.connected, how: workspace.how }
            : null,
          files: skeleton.extras.length + skeleton.docs.filter((doc) => doc.present).length,
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

    // The index is a wall of names, so it carries names. Coverage and file counts belong on the
    // client's own page, where there is room to say what they mean — a bare "4 of 6" on a tile is a
    // number without a question attached to it.
    const folders = clientsIn(paths) as string[];
    const linked = await workspacesByFolder(folders);
    const clients = folders.map((client: string) => {
      const workspace = linked.get(client);
      return {
        client,
        // A workspace's display name wins over the folder name, because the workspace name is the
        // one the team says out loud and the folder name is whatever somebody typed once.
        label: workspace?.name || String(clientLabel(client)),
        logo: logoFor(client, paths, workspace),
        live: Boolean(workspace),
      };
    });

    const areas = BRAIN_AREAS.map((area: { key: string; label: string; prefix: string; blurb: string }) => ({
      ...area,
      files: paths.filter((path) => path.startsWith(area.prefix)).length,
    }));

    return NextResponse.json({ ok: true, repoUrl: BRAIN_URL, clients, areas });
  } catch (error) {
    return NextResponse.json(
      { ok: false, repoUrl: BRAIN_URL, error: error instanceof Error ? error.message : "The QC Brain could not be read." },
      { status: 502 },
    );
  }
}
