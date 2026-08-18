// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Which Airtable base a Reply Radar workspace is.
 *
 * ── Why this is not just `brainFolderFor` with a different list ────────────────────────────────
 * The shape of the question is the same one `shared/brain-link.mjs` answers, and the ladder below is
 * deliberately the same ladder — slug, then name, then containment — so that a client whose brain
 * folder was matched one way is not matched a different way here. What differs is the cost of being
 * wrong, and it differs enough to change the rules.
 *
 * A wrong brain folder shows one client's figures under another client's strategy note. It is read,
 * it is noticed, and nothing outside Reply Radar changed. A wrong Airtable base *writes records into
 * a client's project tracker* — a system other people work out of, that we do not own, where a
 * mistake is somebody else's Monday. So this file is allowed to refuse.
 *
 * ── Refusing is a real answer ──────────────────────────────────────────────────────────────────
 * The base list is not clean. There are two bases called `Client Template 1`, two called
 * `Untitled Base`, a `Hempmatics` and a `Hemaptics`, and `QC Growth`, `QC Growth Internal` and
 * `QC Growth (Automations)` side by side. Given a workspace called "QC Growth", containment matches
 * three bases and picking the first is picking at random.
 *
 * So where two or more bases tie at the best rank, the result is `ambiguous` and carries no base id.
 * A picker showing "three bases match, choose one" is a person doing five seconds of work. The same
 * picker having silently chosen the automations base is a fortnight of tasks written where nobody
 * looks. `brainFolderFor` takes the first match because a read is cheap to correct; this does not.
 */

import { normaliseName } from "./brain-link.mjs";

/** Short generic words like "health" or "labs" must not join a workspace to an unrelated base. */
const LOOSE_FLOOR = 5;

/**
 * The Airtable base a workspace belongs to.
 *
 * @param workspace `{ slug, name, airtableBaseId }` — `airtableBaseId` is the stored, human-chosen answer.
 * @param bases every base the token can see, as `{ id, name }`.
 * @returns `{ baseId, name, how, candidates }` where `how` is why it matched: `chosen` (a person said
 *   so), `slug`, `name`, `loose`, `ambiguous` (several tied, so nothing was picked), or `""` when
 *   nothing matched at all. `candidates` is only populated for `ambiguous`, so a picker can show them.
 */
export function airtableBaseFor(workspace, bases) {
  const list = (Array.isArray(bases) ? bases : [])
    .map((base) => ({ id: String(base?.id ?? ""), name: String(base?.name ?? "") }))
    .filter((base) => base.id);

  const chosen = String(workspace?.airtableBaseId ?? "").trim();
  // A stored answer is returned even when the base is no longer in the list — the token losing access
  // to a base is worth surfacing as "this base is gone", not papering over with a fresh guess that
  // would start writing somewhere else without anybody deciding to.
  if (chosen) {
    const held = list.find((base) => base.id === chosen);
    return { baseId: chosen, name: held?.name ?? "", how: "chosen", candidates: [] };
  }

  const slug = normaliseName(workspace?.slug);
  const name = normaliseName(workspace?.name);
  if (!slug && !name) return { baseId: "", name: "", how: "", candidates: [] };

  const settle = (matches, how) => {
    if (!matches.length) return null;
    // Two bases with the same name is not a tie to be broken, it is a question for a person. Only an
    // exact duplicate id would be safe to collapse, and Airtable does not issue those.
    if (matches.length > 1) return { baseId: "", name: "", how: "ambiguous", candidates: matches };
    return { baseId: matches[0].id, name: matches[0].name, how, candidates: [] };
  };

  const bySlug = settle(slug ? list.filter((base) => normaliseName(base.name) === slug) : [], "slug");
  if (bySlug) return bySlug;

  const byName = settle(name ? list.filter((base) => normaliseName(base.name) === name) : [], "name");
  if (byName) return byName;

  const loose = settle(
    list.filter((base) => {
      const flat = normaliseName(base.name);
      if (flat.length < LOOSE_FLOOR) return false;
      return [slug, name].some((side) => side.length >= LOOSE_FLOOR && (side.includes(flat) || flat.includes(side)));
    }),
    "loose",
  );
  if (loose) return loose;

  return { baseId: "", name: "", how: "", candidates: [] };
}

/**
 * Whether a match is one we are willing to write records through without anybody confirming it.
 *
 * `loose` is deliberately not enough. "Willow" containing "Willow Health" is the good case and the
 * reason containment exists at all, but "Coraa" and "Cora" are one keystroke apart and both plausible
 * client names, and the difference between the two situations is not visible from here. An exact slug
 * or name match is a real agreement between two systems; containment is a hint for a human.
 */
export function isConfidentMatch(how) {
  return how === "chosen" || how === "slug" || how === "name";
}
