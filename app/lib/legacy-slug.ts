// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Slugs a workspace used to have, so a rename never breaks a URL someone else holds.
 *
 * HeyReach's webhook URL ends in the workspace slug, and it is registered on HeyReach's side where QC
 * Command cannot read it back or rewrite it. Renaming a slug (OhMD and Syntasso were created with
 * timestamp placeholders like `workspace-1788465011020`) would otherwise 404 every reply webhook until
 * someone re-registered it by hand — and a client whose polling is down loses those replies outright.
 * So a rename records the old slug in `guardrails.legacy_slugs`, and the webhook routes fall back to it.
 */
export const LEGACY_SLUGS_KEY = "legacy_slugs";

/** PostgREST filter: workspaces whose guardrails list this slug as a former one. */
export function legacySlugFilter(slug: string): string {
  return `guardrails->${LEGACY_SLUGS_KEY}=cs.${encodeURIComponent(JSON.stringify([slug]))}`;
}

/** The former-slug list after renaming `previous` to `next`: previous added, next removed, no repeats. */
export function withLegacySlug(stored: unknown, previous: string, next: string): string[] {
  const list = Array.isArray(stored) ? stored.filter((value): value is string => typeof value === "string" && Boolean(value)) : [];
  return [...new Set([...list, previous])].filter((value) => value && value !== next);
}
