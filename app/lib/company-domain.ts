// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Resolve a company's domain (and logo) from its name — once, then cache it forever.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────────────────────────
 * CRM deals arrive with a company name but often no domain, and QC's leads carry a domain from their own
 * enrichment. With no deal-side domain, the domain-match path can't fire, so real QC deals fall to
 * "review" or "none". Resolving the domain from the name closes that gap — and the same lookup returns a
 * logo, which fills the card when the CRM had none.
 *
 * ── The source ──────────────────────────────────────────────────────────────────────────────────
 * Clearbit's name-to-domain autocomplete: free, no key, returns the most likely `{ name, domain, logo }`
 * for a query. It is best-effort — "Unity" resolves to the most prominent Unity — so a domain found this
 * way still only ever raises a *possible* attribution for a human to confirm, never an automatic
 * "confirmed". That conservatism is deliberate and lives in the matcher, not here.
 *
 * ── Once, not every sync ────────────────────────────────────────────────────────────────────────
 * Every result is written to `rr_company_domains`, keyed by the normalised name and shared across all
 * clients, so a company is looked up exactly once ever. An empty domain is cached too — "we looked and
 * found nothing" — so a fruitless name is never retried on the next sync.
 */

const CLEARBIT = "https://autocomplete.clearbit.com/v1/companies/suggest";
const str = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : String(v));

/** The comparable key for a company name — the same normalisation the attribution matcher uses. */
export function companyKey(name: string): string {
  const bare = String(name || "")
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/\b(inc|llc|ltd|corp|co|company|group|holdings|the|plc|gmbh|sa|pllc|pc|health system|healthcare|hospital)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return bare.replace(/ /g, "").length >= 3 ? bare : "";
}

type Resolved = { domain: string; logo: string };
type SbConfig = { url: string; key: string };

async function readCache(cfg: SbConfig, keys: string[]): Promise<Map<string, Resolved>> {
  const map = new Map<string, Resolved>();
  if (!keys.length) return map;
  const inList = keys.map((k) => encodeURIComponent(k)).join(",");
  const response = await fetch(`${cfg.url}/rest/v1/rr_company_domains?select=name_key,domain,logo&name_key=in.(${inList})`, {
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
    cache: "no-store",
  }).catch(() => null);
  const rows = (await response?.json().catch(() => [])) as Record<string, unknown>[] | undefined;
  for (const row of rows ?? []) map.set(str(row.name_key), { domain: str(row.domain), logo: str(row.logo) });
  return map;
}

async function writeCache(cfg: SbConfig, rows: { name_key: string; name: string; domain: string; logo: string }[]): Promise<void> {
  if (!rows.length) return;
  await fetch(`${cfg.url}/rest/v1/rr_company_domains?on_conflict=name_key`, {
    method: "POST",
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows.map((r) => ({ ...r, resolved_at: new Date().toISOString() }))),
  }).catch(() => {});
}

/** One live Clearbit lookup. Returns empty strings on any miss or error — a cacheable "nothing found". */
async function lookup(name: string): Promise<Resolved> {
  try {
    const response = await fetch(`${CLEARBIT}?query=${encodeURIComponent(name)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      // The autocomplete endpoint is built for browser widgets and returns an empty list to requests
      // with no User-Agent — which is exactly what a bare server fetch sends, and why every lookup came
      // back blank. A browser-shaped UA is all it wants.
      headers: { "user-agent": "Mozilla/5.0 (compatible; ReplyRadar/1.0)", accept: "application/json" },
    });
    if (!response.ok) return { domain: "", logo: "" };
    const body = (await response.json().catch(() => [])) as Array<Record<string, unknown>>;
    const first = Array.isArray(body) ? body[0] : undefined;
    const domain = str(first?.domain);
    // Autocomplete always returns `logo: null`; the real logo comes from Clearbit's logo endpoint, built
    // from the domain we just found. So a resolved domain also yields a usable logo.
    return { domain, logo: domain ? `https://logo.clearbit.com/${domain}` : "" };
  } catch {
    return { domain: "", logo: "" };
  }
}

/**
 * Resolve many company names at once, cache-first.
 *
 * @param cfg    Supabase url/key
 * @param names  the raw company names off the deals
 * @returns a map from raw name → { domain, logo } (either may be empty)
 */
export async function resolveCompanyDomains(cfg: SbConfig, names: string[]): Promise<Map<string, Resolved>> {
  const out = new Map<string, Resolved>();
  // Map each raw name to its key, dropping ones too thin to look up.
  const byKey = new Map<string, string>();
  for (const name of names) {
    const key = companyKey(name);
    if (key && !byKey.has(key)) byKey.set(key, name);
  }
  if (!byKey.size) return out;

  const cached = await readCache(cfg, [...byKey.keys()]);
  const misses: [string, string][] = [];
  for (const [key, name] of byKey) {
    const hit = cached.get(key);
    if (hit) out.set(name, hit);
    else misses.push([key, name]);
  }

  // Only the misses hit Clearbit, four at a time so a big first sync stays polite.
  const fresh: { name_key: string; name: string; domain: string; logo: string }[] = [];
  const LANES = 4;
  for (let i = 0; i < misses.length; i += LANES) {
    await Promise.all(misses.slice(i, i + LANES).map(async ([key, name]) => {
      const resolved = await lookup(name);
      out.set(name, resolved);
      fresh.push({ name_key: key, name, domain: resolved.domain, logo: resolved.logo });
    }));
  }
  await writeCache(cfg, fresh);
  return out;
}
