// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import BrainApp from "../BrainApp";
import { brainConfigured, brainTree } from "../../lib/brain";
import { workspacesByFolder } from "../../lib/brain-workspaces";
import { clientsIn } from "../../../shared/brain-structure.mjs";

/**
 * A client's own address: `/qc-brain/willow`, or `willow.replyradar.app/qc-brain`.
 *
 * ── Why a client needs a URL at all ─────────────────────────────────────────────────────────────
 * The rest of this tab is one component switching a `view` field, which is right — every screen is
 * instant off one cached tree. But a client with no address cannot be linked to, and pasting a link
 * is how anything here actually gets shared. So this route renders the same component with the
 * client already chosen; the component keeps the address bar in step from then on without
 * navigating.
 *
 * ── Why the name in the URL is resolved rather than used ────────────────────────────────────────
 * Two things arrive here. `/qc-brain/willow` carries a brain folder name, typed by someone who was
 * just looking at one. A subdomain carries a Reply Radar workspace slug, which is a different naming
 * system that agrees with the folder names for most clients and quietly disagrees for some. Sending
 * an unresolved slug through would give those clients a "there is nothing under clients/…" page on
 * their own subdomain, so the workspace-to-folder tether answers it — the same answer the rest of
 * the app uses, which is the entire reason that tether exists rather than a match per feature.
 */
export default async function ClientBrainPage({ params }: { params: Promise<{ client: string }> }) {
  const { client } = await params;
  return <BrainApp initialClient={await folderFor(decodeURIComponent(client))} />;
}

async function folderFor(name: string) {
  if (!name || !brainConfigured()) return name;
  try {
    const folders = clientsIn((await brainTree()).map((file) => file.path)) as string[];
    if (folders.includes(name)) return name;
    for (const [folder, workspace] of await workspacesByFolder(folders)) {
      if (workspace.slug === name) return folder;
    }
  } catch {
    // The page fetches its own data and reports its own failures; guessing wrong here at worst
    // shows the folder-not-found message the unresolved name would have shown anyway.
  }
  return name;
}
