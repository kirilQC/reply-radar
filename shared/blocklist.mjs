// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Who we refuse to store, and how we recognise them next time.
 *
 * The problem this solves. Some replies are not leads at all — the client's friend, a recruiter, a
 * colleague saying hello. Deleting them worked, and then their next message arrived and ingestion
 * recreated the whole person from scratch: new lead row, new conversation, back in the inbox. Deleting
 * the same person every week is the bug; there was no way to say "not this person, ever".
 *
 * Why this is stored, when the inbound-first rule next door in `conversation-origin.mjs` deliberately
 * stores nothing. That rule is a *derivation* — it reads the messages and works out whether we opened
 * the conversation, so correcting the rule immediately re-includes everyone it had been excluding. A
 * block is not a derivation. It is a person looking at a reply and deciding, and nothing in the data
 * implies it. There is nothing to re-derive from, so it has to be written down.
 *
 * Why the key is the LinkedIn profile URL and nothing else. `rr_leads` is keyed per client, so the same
 * person is a different row for every client we run — and a fresh row, with a fresh id, every time
 * ingestion meets them again. A block on a lead id, a HeyReach id or a conversation id would be defeated
 * by the very next webhook, which is exactly the failure being fixed. The profile URL is the only
 * identifier that survives, and it is already what `lead-deletion.ts` uses to decide that two rows are
 * one person.
 *
 * Lives in shared/ as plain ESM so the app, the worker and the .mjs tests all agree on one key format.
 * If the app normalised differently from the check, a block would appear to save and never fire.
 */

/**
 * The stored form of a LinkedIn profile URL.
 *
 * Lower-cased, query string dropped, trailing slash dropped — the same normalisation ingestion applies
 * before writing `rr_leads.linkedin_profile_url`, so a key built here matches the column as stored.
 * `?utm_source=…` and a trailing slash are the two ways the same profile arrives looking like two
 * people; both come off HeyReach payloads and out of pasted links.
 *
 * Returns "" for anything unusable, which callers must treat as "cannot be blocked" rather than as a
 * key. An empty key would match every lead with no profile URL at all.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function profileKey(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  return raw.toLowerCase().replace(/\?.*$/, "").replace(/\/$/, "");
}

/**
 * Whether this profile is on the list.
 *
 * Takes the keys as a set the caller has already fetched rather than doing its own lookup, so that one
 * ingestion pass makes one query. A profile with no URL is never blocked: we cannot tell it apart from
 * the next one, and refusing a real lead is far more expensive than storing an unwanted one.
 *
 * @param {unknown} url
 * @param {Set<string>} blockedKeys
 * @returns {boolean}
 */
export function isBlockedProfile(url, blockedKeys) {
  const key = profileKey(url);
  return Boolean(key) && blockedKeys.has(key);
}
