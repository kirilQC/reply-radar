/**
 * Which campaigns are ours.
 *
 * The problem this solves. Several clients ran their own HeyReach outbound before hiring us, and those
 * campaigns are still sitting in the same account under the same API key. Every figure derived from
 * "all campaigns in this workspace" therefore included work we did not do — most visibly the engagement
 * duration, which measured from a client's *first ever* campaign and so claimed we had been working
 * together since before the contract existed.
 *
 * Nothing in the HeyReach payload marks a campaign as ours. There is no folder, no tag, no owner field
 * that distinguishes the client's own attempts from the ones we launched. The only signal is the naming
 * convention we apply ourselves: a short client code, then the campaign's number in sequence. `CT003` is
 * Cotool's third, `SW019` is Steadywell's nineteenth.
 *
 * ── Why the pattern is looser than the convention ───────────────────────────────────────────────────
 * The convention is "two letters then two or three digits". The live accounts are not that tidy, and a
 * literal `^[A-Z]{2}\d{2,3}` would have thrown away real work:
 *
 *   - `W040: Website ICP Visitors`  — Willow uses ONE letter. That regex loses every Willow campaign.
 *   - `CT50: ...`                   — two digits, not three.
 *   - `CT049_R3_Connect_Logan`      — underscore separator, no colon.
 *   - `CT:010 BSidesSD Speakers`    — colon before the digits rather than after.
 *   - `Ct007: ...`                  — lower-case second letter.
 *   - `  SW019: ...`                — leading whitespace, straight from the API.
 *
 * So: one to three letters, an optional colon, two or three digits. Case-insensitive, trimmed first.
 *
 * ── Why it is not looser still ──────────────────────────────────────────────────────────────────────
 * Every character dropped from the pattern lets a client's own campaign back in. Two hold the line:
 *
 *   - The digits must follow the letters immediately. No space. `BH Pipeline Bucket` has no digits at
 *     all, but `BH 2026 Attendees` does, and allowing a space between letters and digits would admit it.
 *   - A trailing boundary rejects a fourth digit or a further letter. Without it a four-digit year keeps
 *     matching — `BH 2026` is the year, `BH026` would be a campaign — and `Ws2025Q1` would pass as `Ws202`.
 *
 * Anything that fails is not deleted from HeyReach; it is simply not ours to report on. Excluded data
 * gets no UI, so it is dropped at the point the rows are read rather than flagged downstream.
 */

/**
 * `true` when a HeyReach campaign name carries a QC campaign code.
 *
 * @param {unknown} name The campaign name exactly as HeyReach returned it.
 * @returns {boolean}
 */
export function isOurCampaign(name) {
  if (typeof name !== "string") return false;
  return /^[a-z]{1,3}:?\d{2,3}(?![a-z0-9])/i.test(name.trim());
}

/**
 * The code a campaign name carries, in one canonical form.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * The QC Brain's strategy notes are written in prose and refer to campaigns by code — "CT003 is the
 * one that worked", "we paused W040". HeyReach knows those same campaigns as `CT:010 BSidesSD
 * Speakers` and `CT049_R3_Connect_Logan`. Joining the two is the whole reason a front end for the
 * brain belongs inside Reply Radar rather than being a nicer docs site: what we said we would do can
 * sit next to what actually happened.
 *
 * The join only works if both sides agree on what the code *is*, and they are written differently:
 * `Ct007`, `CT:010`, `  SW019` and `W040` are four spellings of the same idea. So both sides are put
 * through here — uppercased, colon dropped — and compared as strings.
 *
 * The digits are deliberately not padded. `CT50` and `CT050` are two campaigns in a real account, and
 * normalising them together would report one's numbers under the other's name.
 *
 * @param {unknown} name A campaign name, or a code found in prose.
 * @returns {string} `"CT003"`, or `""` when there is no code.
 */
export function campaignCode(name) {
  if (typeof name !== "string") return "";
  const match = /^([a-z]{1,3}):?(\d{2,3})(?![a-z0-9])/i.exec(name.trim());
  return match ? `${match[1].toUpperCase()}${match[2]}` : "";
}

/**
 * Keeps only the rows whose campaign name is ours.
 *
 * Takes a name-reader rather than a fixed key because the two HeyReach endpoints disagree:
 * `/stats/GetOverallStatsByCampaign` calls it `campaignName`, `/campaign/GetAll` calls it `name`.
 * Passing the reader in keeps one rule for both instead of one rule per shape.
 *
 * @template T
 * @param {T[]} rows
 * @param {(row: T) => unknown} nameOf
 * @returns {T[]}
 */
export function ourCampaigns(rows, nameOf) {
  return (Array.isArray(rows) ? rows : []).filter((row) => isOurCampaign(nameOf(row)));
}
