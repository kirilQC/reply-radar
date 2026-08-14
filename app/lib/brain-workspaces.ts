/**
 * Reply Radar's own clients, in the shape the QC Brain needs to recognise them.
 *
 * ── Why this is separate from everything else that reads workspaces ────────────────────────────
 * Two routes need the same three questions answered — which workspace is this folder, does it have
 * a logo, is it connected to HeyReach — and they were about to answer them twice with two slightly
 * different fuzzy matches. Two slightly different answers to "which client is this" is the precise
 * failure this whole bridge exists to prevent, so the query and the match live in one place and both
 * routes call it.
 *
 * ── Why the logo comes from here rather than from the repo ─────────────────────────────────────
 * The brain has no logos in it; almost no client folder carries one and nobody is going to commit
 * eighteen PNGs. Reply Radar already has all of them, uploaded through the admin console and stored
 * on the workspace as a data URL. So the client index draws Reply Radar's logo and falls back to a
 * committed `logo.*` only for folders that are not set up here — prospects, mostly. The bridge is
 * what makes that possible, and it is the first thing it pays for.
 *
 * A data URL costs nothing extra to serve: it is already in the row this route had to read anyway,
 * and it avoids a second round trip per client to an image endpoint.
 */
import { linkWorkspaces } from "../../shared/brain-link.mjs";

export type BrainWorkspace = {
  id: string;
  name: string;
  slug: string;
  logo: string;
  connected: boolean;
  /** Why this workspace was matched to its folder — `chosen` when a person said so. */
  how: string;
  apiKey: string;
};

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");

/**
 * Every workspace, keyed by the brain folder it belongs to.
 *
 * Returns an empty map rather than throwing when Supabase is unreachable. The brain is readable
 * without Reply Radar's database — it is a GitHub repo — and taking the whole tab down because the
 * logos could not be fetched would be a poor trade.
 */
export async function workspacesByFolder(folders: string[]): Promise<Map<string, BrainWorkspace>> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const empty = new Map<string, BrainWorkspace>();
  if (!url || !key) return empty;

  const select = "id,name,slug,logo_url,brain_folder,heyreach_api_key_ciphertext";
  let response = await fetch(`${url}/rest/v1/rr_workspaces?select=${select}&order=name.asc`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  }).catch(() => null);
  // `brain_folder` is an additive migration. Until it is run the guess still works, so the feature
  // degrades to "matched by name" rather than to nothing.
  if (response && !response.ok) {
    response = await fetch(
      `${url}/rest/v1/rr_workspaces?select=id,name,slug,logo_url,heyreach_api_key_ciphertext&order=name.asc`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" },
    ).catch(() => null);
  }
  if (!response?.ok) return empty;

  const rows = ((await response.json().catch(() => [])) as Row[]) ?? [];
  const candidates = rows.map((row) => ({
    id: text(row.id),
    name: text(row.name),
    slug: text(row.slug),
    logo: text(row.logo_url),
    apiKey: text(row.heyreach_api_key_ciphertext),
    brainFolder: text(row.brain_folder),
  }));

  const linked = linkWorkspaces(candidates, folders) as Map<string, { workspace: (typeof candidates)[number]; how: string }>;
  const byFolder = new Map<string, BrainWorkspace>();
  for (const [folder, { workspace, how }] of linked) {
    byFolder.set(folder, {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      logo: workspace.logo,
      connected: Boolean(workspace.apiKey),
      apiKey: workspace.apiKey,
      how,
    });
  }
  return byFolder;
}
