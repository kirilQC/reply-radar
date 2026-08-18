// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * How many days of sending a campaign has left.
 *
 * ── Why this is shared rather than declared where it is used ─────────────────────────────────────────
 * Three places need this number and they must not disagree: the client-facing campaign report, the
 * morning brief that tells the team when to start building new campaigns, and the to-do pulse check.
 * A brief that says "two days left" beside a report that says four is worse than either being wrong on
 * its own, because the team stops trusting both and goes back to counting by hand.
 *
 * It lives in `shared/` as plain ESM for a second reason: `morning-brief.ts` is deliberately free of
 * relative imports so its tests can load it directly under Node's TypeScript loader, which will not
 * resolve an extensionless relative path. A `.mjs` file imported with its extension is the one thing
 * that file can import, which is why the constant moved here rather than being typed out twice.
 */

/**
 * Connection requests one LinkedIn account sends in a day.
 *
 * QC's own sending cap, not LinkedIn's limit — it is the number the pulse check and the campaign
 * schedules are both built around, so a runway calculated from anything else would contradict what the
 * team already tells clients.
 */
export const DAILY_CONNECTIONS_PER_SENDER = 25;

/**
 * How much longer a campaign has to run before its list is exhausted.
 *
 * Pending leads divided by the daily send capacity, which is the sender count times the per-sender cap:
 * 500 pending across 4 senders is 100 a day, so five days left. It is the answer to the question a
 * client actually asks about a campaign — not "how big is the list" but "when do you need more leads?"
 *
 * Null rather than zero when there are no senders. A campaign with nobody assigned is not finishing
 * today; it is not sending at all, and the honest answer is that we cannot say.
 */
export function sendingDaysLeft(pending, senders) {
  if (!Number.isFinite(pending) || !Number.isFinite(senders) || senders <= 0) return null;
  if (pending <= 0) return 0;
  return Math.ceil(pending / (senders * DAILY_CONNECTIONS_PER_SENDER));
}
