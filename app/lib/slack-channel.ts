// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Reading a Slack channel id out of whatever somebody pasted.
 *
 * Separate from `slack.ts` because the configuration page validates the field as it is typed, and that
 * page is a client component. These two functions are pure string work; everything in `slack.ts`
 * carries a bot token and belongs on the server only.
 */

/**
 * The field asks for an id, and people will paste a name (`#qc-willow`) or the URL from their address
 * bar, because that is what is to hand when you are looking at the channel. A name cannot be used —
 * resolving one needs a `conversations.list` walk of the whole workspace, and it breaks the day
 * somebody renames the channel, which is exactly the silent failure this feature cannot afford. So a
 * URL is mined for the id it already contains, and anything else is handed back for `looksLikeChannelId`
 * to reject on screen rather than saved and left to fail at 8am on a Monday.
 */
export function normalizeChannelId(input: unknown): string {
  const raw = typeof input === "string" ? input.trim() : "";
  if (!raw) return "";
  // https://acme.slack.com/archives/C09ABCDEF/p1700000000000000 — the id is the archives segment.
  const fromUrl = raw.match(/\/archives\/([A-Z0-9]+)/i);
  const candidate = (fromUrl ? fromUrl[1] : raw).replace(/^#/, "").trim();
  return /^[A-Za-z0-9]+$/.test(candidate) ? candidate.toUpperCase() : candidate;
}

/**
 * Whether a normalised value is a channel id at all.
 *
 * Slack ids start with C (public channel), G (private group) or D (direct message). The length is left
 * loose on purpose: Slack has widened these before, and a validator that rejects a genuine new id is
 * worse than one that lets a typo through to a clear `channel_not_found` from Slack itself.
 */
export function looksLikeChannelId(value: string): boolean {
  return /^[CGD][A-Z0-9]{6,}$/.test(value.trim().toUpperCase());
}
