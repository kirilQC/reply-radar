/**
 * Reading and writing the block list over PostgREST.
 *
 * The key format itself lives in `shared/blocklist.mjs`, because ingestion and the tests need it too and
 * a block written with one normalisation and checked with another would never fire.
 *
 * Every read here tolerates the table not existing. `rr_blocked_leads` arrives with a migration the owner
 * runs by hand, and until it is run a missing table means "nobody is blocked" — which is the truth, and a
 * far better answer than ingestion throwing on every webhook because a feature was deployed ahead of its
 * schema. Writes do not get the same forgiveness: a block that silently does nothing is the bug this
 * feature exists to fix, so it must say so.
 */
import { profileKey } from "../../shared/blocklist.mjs";

export type BlockedLead = { profileKey: string; name: string; reason: string; blockedAt: string };

const auth = (key: string) => ({ apikey: key, Authorization: `Bearer ${key}` });

/** PostgREST answers a table that isn't there with 404, and an undefined relation with 42P01. */
const missingTable = (status: number, body: unknown) =>
  status === 404 || (typeof body === "string" ? body : JSON.stringify(body ?? "")).includes("42P01");

async function read(url: string, key: string, path: string): Promise<Record<string, unknown>[] | null> {
  const response = await fetch(`${url}/rest/v1/${path}`, { headers: auth(key), cache: "no-store" });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (missingTable(response.status, data)) return null;
    throw new Error(`Supabase ${response.status} on ${path}: ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) ? (data as Record<string, unknown>[]) : [];
}

/**
 * Every blocked profile key, as a set for the ingestion check.
 *
 * The whole list, not a lookup per lead: it is a handful of people the agency has explicitly refused, and
 * one query per webhook is cheaper than a round trip inside the hot path. The cap is there so that if the
 * list ever does grow past reason, the failure is a stale block rather than an unbounded fetch.
 */
export async function blockedProfileKeys(url: string, key: string): Promise<Set<string>> {
  const rows = await read(url, key, "rr_blocked_leads?select=profile_key&limit=5000");
  if (!rows) return new Set();
  return new Set(rows.map((row) => profileKey(row.profile_key)).filter(Boolean));
}

/** The list as the UI shows it, newest block first, so an accidental block is the first thing to undo. */
export async function listBlockedLeads(url: string, key: string): Promise<BlockedLead[]> {
  const rows = await read(
    url,
    key,
    "rr_blocked_leads?select=profile_key,name,reason,blocked_at&order=blocked_at.desc&limit=500",
  );
  if (!rows) return [];
  return rows.map((row) => ({
    profileKey: String(row.profile_key ?? ""),
    name: String(row.name ?? ""),
    reason: String(row.reason ?? ""),
    blockedAt: String(row.blocked_at ?? ""),
  }));
}

/**
 * Adds a profile to the list, or refreshes the note on one already there.
 *
 * `resolution=merge-duplicates` rather than an insert that fails on conflict: blocking someone twice is a
 * thing people do when the first attempt didn't visibly change anything, and it should be a no-op instead
 * of an error.
 */
export async function blockProfile(
  url: string,
  key: string,
  profile: { profileKey: string; name?: string; reason?: string },
): Promise<void> {
  const response = await fetch(`${url}/rest/v1/rr_blocked_leads?on_conflict=profile_key`, {
    method: "POST",
    headers: {
      ...auth(key),
      "content-type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({
      profile_key: profile.profileKey,
      name: profile.name?.slice(0, 200) || null,
      reason: profile.reason?.slice(0, 500) || null,
      blocked_at: new Date().toISOString(),
    }),
    cache: "no-store",
  });
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  if (missingTable(response.status, body)) {
    throw new Error(
      "The block list table does not exist yet. Run supabase/migrations/20260813_rr_blocked_leads.sql, then try again.",
    );
  }
  throw new Error(`Could not block this profile: Supabase ${response.status} ${body}`);
}

/**
 * Removes a profile from the list. Returns whether a row was actually removed, via
 * `return=representation` — the house rule, because a delete that matched nothing otherwise looks exactly
 * like one that worked, and the caller would report an unblock that never happened.
 */
export async function unblockProfile(url: string, key: string, rawKey: string): Promise<boolean> {
  const normalised = profileKey(rawKey);
  if (!normalised) return false;
  const response = await fetch(
    `${url}/rest/v1/rr_blocked_leads?profile_key=eq.${encodeURIComponent(normalised)}`,
    {
      method: "DELETE",
      headers: { ...auth(key), "content-type": "application/json", Prefer: "return=representation" },
      cache: "no-store",
    },
  );
  const data = await response.json().catch(() => []);
  if (!response.ok) {
    if (missingTable(response.status, data)) return false;
    throw new Error(`Supabase ${response.status} unblocking: ${JSON.stringify(data)}`);
  }
  return Array.isArray(data) && data.length > 0;
}
