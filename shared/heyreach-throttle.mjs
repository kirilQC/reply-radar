// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * One gate in front of every HeyReach call this process makes.
 *
 * HeyReach allows 15 requests per 2 seconds per API key. Scout runs tools in parallel, so a single answer
 * that exported a dozen lists fired them all at once and half came back 429 (seen on 2026-10-02: 14 of 50
 * calls failed). Calls with the same key now queue for a slot (at most 6 started per second, which keeps
 * a burst under the limit), and a 429 that still slips through is retried once after the window clears.
 */

const PER_SECOND = 6;
const windows = new Map();

/** @param {string} key */
async function slot(key) {
  for (;;) {
    const now = Date.now();
    const recent = (windows.get(key) ?? []).filter((t) => now - t < 1000);
    if (recent.length < PER_SECOND) {
      recent.push(now);
      windows.set(key, recent);
      return;
    }
    const wait = 1000 - (now - recent[0]) + 5;
    windows.set(key, recent);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** `fetch`, but queued per HeyReach API key and retried once on a 429. */
/**
 * @param {string} apiKey
 * @param {string} url
 * @param {RequestInit} init
 * @returns {Promise<Response>}
 */
export async function heyreachFetch(apiKey, url, init) {
  const key = apiKey.slice(-12) || "anon";
  await slot(key);
  const response = await fetch(url, init);
  if (response.status !== 429) return response;
  await new Promise((resolve) => setTimeout(resolve, 2200));
  await slot(key);
  return fetch(url, init);
}
