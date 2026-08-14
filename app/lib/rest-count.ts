// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * How many rows match a filter, without fetching them.
 *
 * PostgREST reports the total in `Content-Range` when asked for an exact count, so a heading or a
 * stat tile can show a real total instead of the size of whatever page happened to be loaded. Asking
 * for `Range: 0-0` keeps the body to a single row.
 *
 * Returns null rather than throwing: a stat that cannot be counted should read as unknown, not take
 * the page down with it.
 */
export async function countRows(url: string, key: string, path: string): Promise<number | null> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact", Range: "0-0" },
    cache: "no-store",
  }).catch(() => null);
  if (!response?.ok) return null;
  const total = Number(String(response.headers.get("content-range") ?? "").split("/")[1]);
  return Number.isFinite(total) ? total : null;
}
