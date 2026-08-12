/**
 * The key/value store for small app-wide settings: `rr_app_config`.
 *
 * Three routes needed this and each had written its own copy against `rr_global_config`, querying it as
 * `select=key,value&key=eq.<name>`. That table is a single-row settings table — `id boolean primary key`
 * with one column per setting — and has no `key` or `value` column, so every one of those calls failed
 * with "column rr_global_config.key does not exist". Reads were caught and reported as "nothing saved
 * yet" and one of the writes returned `{ ok: response.ok }` without showing the error, which is how the
 * sentiment prompt appeared to save for months without ever being stored.
 *
 * Centralised so there is one description of the shape and one place to be wrong about it. Anything that
 * grows without bound still gets a real table; `rr_reports` is the example.
 *
 * See `supabase/migrations/20260812_rr_app_config.sql`.
 */
const TABLE = "rr_app_config";
export const APP_CONFIG_MIGRATION = "supabase/migrations/20260812_rr_app_config.sql";

type Row = Record<string, unknown>;

async function rest(path: string, init?: RequestInit) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    // PostgREST explains itself in the body — a missing column, a failed constraint, the wrong conflict
    // target. Reporting the bare status turns all of those into the same unactionable "400", which is
    // what made this family of failures impossible to diagnose from the UI.
    const detail = await response.text().catch(() => "");
    const parsed = (() => {
      try {
        return JSON.parse(detail) as { message?: string; hint?: string };
      } catch {
        return null;
      }
    })();
    const because = [parsed?.message, parsed?.hint].filter(Boolean).join(" — ") || detail.slice(0, 200);
    throw new Error(`Supabase ${TABLE} ${response.status}${because ? `: ${because}` : ""}`);
  }
  return response;
}

/** The value stored under one key, or `undefined` if nothing is stored there. Throws if the read fails. */
export async function readConfig(key: string): Promise<unknown> {
  const response = await rest(`${TABLE}?select=key,value&key=eq.${encodeURIComponent(key)}&limit=1`);
  const rows = (await response.json().catch(() => [])) as Row[];
  return rows[0]?.value;
}

/** Every value whose key starts with `prefix`, for settings that are per-client variants of one thing. */
export async function readConfigPrefix(prefix: string): Promise<Map<string, unknown>> {
  const response = await rest(`${TABLE}?select=key,value&key=like.${encodeURIComponent(`${prefix}*`)}`);
  const rows = (await response.json().catch(() => [])) as Row[];
  return new Map(rows.filter((row) => typeof row.key === "string").map((row) => [row.key as string, row.value]));
}

/**
 * Writes one key, replacing whatever was there.
 *
 * An upsert is safe because `key` is the table's primary key — `resolution=merge-duplicates` compiles to
 * `ON CONFLICT (key)`, which PostgREST only accepts when a constraint backs the column.
 */
export async function writeConfig(key: string, value: unknown): Promise<void> {
  await rest(TABLE, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
}

/**
 * Reads a stored list, tolerating both a JSON string and an already-parsed array.
 *
 * Which one comes back depends on whether an older row was written stringified into the jsonb column,
 * and callers should not have to know which.
 */
export function asList(raw: unknown): unknown[] {
  const parsed = typeof raw === "string" ? JSON.parse(raw || "[]") : raw;
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * The message a teammate sees when a write fails.
 *
 * A missing table is the one failure they can fix themselves, so it names the file to run instead of
 * quoting a PostgREST code. Everything else passes through untouched.
 */
export function explainConfigError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : "";
  if (!message) return fallback;
  return /does not exist|schema cache|relation/i.test(message)
    ? `${message} — run ${APP_CONFIG_MIGRATION} in the Supabase SQL editor.`
    : message;
}
