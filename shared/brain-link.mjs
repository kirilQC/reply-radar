/**
 * Which QC Brain folder a Reply Radar workspace is, and vice versa.
 *
 * ── Why this needs to exist at all ─────────────────────────────────────────────────────────────
 * Two systems grew up naming the same eighteen companies independently. The brain names them by
 * folder — `bluevia-health`, `Steadywell` — because somebody typed a folder name. Reply Radar names
 * them by a slug and a display name, because somebody typed those into an admin form. Nobody ever
 * agreed the two should agree, and mostly they do, which is worse than if they never did: it means
 * the mismatches are rare enough to be surprising and frequent enough to be wrong.
 *
 * Everything the two halves can do for each other runs through this one question. The brain has the
 * strategy and the context; Reply Radar has the leads, the replies and the live campaign figures.
 * Neither is worth much to the other until a folder and a workspace are known to be the same client.
 *
 * ── Why guessing is not enough, and why it is still the default ────────────────────────────────
 * A guess is right for most clients and silently wrong for the rest, and a silently wrong join is
 * worse than no join — it would show one client's reply rate under another client's strategy note.
 * So a person can always overrule it, by storing a folder on the workspace, and the stored answer
 * wins over every rule below.
 *
 * But requiring the stored answer for all eighteen would mean the feature does nothing until
 * somebody does eighteen pieces of data entry, which in practice means it does nothing. So the rules
 * run when nothing is stored, and every result says how it was reached, so an interface can show a
 * confident match differently from a loose one and let somebody confirm it in a click.
 *
 * ── The order, and why it is this order ────────────────────────────────────────────────────────
 * Exact matches first, in descending order of how deliberate the name is. A slug is a machine name
 * somebody chose once and never sees, so two slugs agreeing is a strong signal. A display name is
 * edited freely and can be anything. Containment is last and is marked `loose`, because "Willow"
 * containing "Willow Health" is a good guess and "Health" containing "Health" is not — the length
 * floor exists so short generic words cannot bridge two unrelated clients.
 */

/** Lowercase, with punctuation and spacing flattened, so `Bluevia Health` and `bluevia-health` meet. */
export function normaliseName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Short generic words like "health" or "labs" must not join two unrelated clients on their own. */
const LOOSE_FLOOR = 5;

/**
 * The brain folder a workspace belongs to.
 *
 * @param workspace `{ slug, name, brainFolder }` — `brainFolder` is the stored, human-chosen answer.
 * @param folders every client folder name in the brain.
 * @returns `{ folder, how }` where `how` is why it matched: `chosen` (a person said so), `slug`,
 *   `name`, `loose` (one name contains the other), or `""` when nothing matched.
 */
export function brainFolderFor(workspace, folders) {
  const list = (Array.isArray(folders) ? folders : []).map(String);
  const chosen = String(workspace?.brainFolder ?? "").trim();
  // A stored answer is returned even if the folder has since been renamed or deleted. Quietly
  // falling back to a guess would hide the rename, and the rename is the thing worth knowing.
  if (chosen) return { folder: chosen, how: "chosen" };

  const slug = normaliseName(workspace?.slug);
  const name = normaliseName(workspace?.name);
  if (!slug && !name) return { folder: "", how: "" };

  const bySlug = slug && list.find((folder) => normaliseName(folder) === slug);
  if (bySlug) return { folder: bySlug, how: "slug" };

  const byName = name && list.find((folder) => normaliseName(folder) === name);
  if (byName) return { folder: byName, how: "name" };

  const loose = list.find((folder) => {
    const flat = normaliseName(folder);
    if (flat.length < LOOSE_FLOOR) return false;
    return [slug, name].some((side) => side.length >= LOOSE_FLOOR && (side.includes(flat) || flat.includes(side)));
  });
  return loose ? { folder: loose, how: "loose" } : { folder: "", how: "" };
}

/**
 * The same question from the other side: the workspace a brain folder belongs to.
 *
 * Built by running every workspace through `brainFolderFor` rather than by writing a second set of
 * rules, so the two directions cannot disagree — a folder that claims a workspace and a workspace
 * that claims a different folder is exactly the bug this file exists to prevent.
 *
 * Where two workspaces resolve to one folder, the more deliberate match wins: a workspace that was
 * explicitly pointed at the folder beats one that merely has a similar name.
 */
const RANK = { chosen: 3, slug: 2, name: 1, loose: 0 };

export function linkWorkspaces(workspaces, folders) {
  const links = new Map();
  for (const workspace of Array.isArray(workspaces) ? workspaces : []) {
    const { folder, how } = brainFolderFor(workspace, folders);
    if (!folder) continue;
    const held = links.get(folder);
    if (held && RANK[held.how] >= RANK[how]) continue;
    links.set(folder, { workspace, how });
  }
  return links;
}
