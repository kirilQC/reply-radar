// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The I/O half of Jev's enrichment: reading company websites, scraping LinkedIn profiles through Bright Data,
 * and having a cheap model structure what came back. Pure logic is in `shared/enrich.mjs`.
 *
 * ── Why websites are read directly, not through a scraping service ───────────────────────────────
 * A company homepage is public HTML and a plain fetch with browser-like headers reads most of them in well under
 * a second, at no cost. A reader service (Jina) is used only when `JINA_API_KEY` is set and the direct read
 * failed — it renders JavaScript-only sites the direct read cannot. The first test, with a bare user-agent, was
 * served a firewall's "Not Acceptable" page instead of the site; the headers below are what fixed it.
 *
 * ── Why LinkedIn goes through Bright Data's async API ────────────────────────────────────────────
 * Bright Data scrapes from its own infrastructure, so no LinkedIn account or cookie of ours is ever involved —
 * the rule is never to put a sender account at risk. Its synchronous endpoint can take a full minute, longer than
 * a Vercel function may run, so a batch is triggered, the browser polls, and the snapshot is collected when ready.
 *
 * ── Why the host is checked before every fetch ───────────────────────────────────────────────────
 * The URLs come from an uploaded CSV. Without a check, a row reading "localhost:5432" or a cloud metadata
 * address would have this server fetch its own internals and hand the text to a model.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { batchPrompt, htmlToText, splitBatchAnswer, structureBatchInput, structureBatchSchema, trimLinkedinRecord, unusablePage } from "../../shared/enrich.mjs";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 1_500_000;
const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};
const PROFILES_DATASET = "gd_l1viktl72bvl7bjuj0";
/** Overridable for a proxy or a test double; Bright Data itself is the default. */
const brightDataBase = () => (process.env.BRIGHTDATA_BASE_URL || "https://api.brightdata.com").replace(/\/+$/, "");
/** Cheap, fast, and it returns null rather than inventing — the test that ruled out a cheaper model. */
const DEFAULT_STRUCTURE_MODEL = "openai/gpt-6-luna";

export function enrichConfig() {
  return {
    brightData: Boolean(process.env.BRIGHTDATA_API_KEY),
    jina: Boolean(process.env.JINA_API_KEY),
    structureModel: process.env.JEV_STRUCTURE_MODEL || DEFAULT_STRUCTURE_MODEL,
    // Requests a minute the browser paces itself to. 18 sits under the 20/min OpenRouter gives new accounts;
    // raise it with JEV_STRUCTURE_RPM once the account's limit is higher.
    structureRpm: Math.max(1, Number(process.env.JEV_STRUCTURE_RPM) || 18),
    llm: Boolean(process.env.OPENROUTER_API_KEY),
  };
}

/* ── Safety ── */

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v === "::") return true;
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? privateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function safeUrl(raw: string): Promise<URL | null> {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) return null;
  try {
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => privateAddress(a.address))) return null;
  } catch { return null; }
  return u;
}

/* ── Websites ── */

async function fetchHtml(url: string): Promise<{ ok: boolean; status: number; html?: string; finalUrl?: string; error?: string }> {
  const safe = await safeUrl(url);
  if (!safe) return { ok: false, status: 0, error: "not a public website address" };
  try {
    const response = await fetch(safe, { headers: BROWSER_HEADERS, redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    // A redirect can land anywhere; the final host is checked too.
    if (response.url && response.url !== safe.href && !(await safeUrl(response.url))) return { ok: false, status: 0, error: "redirected to a non-public address" };
    const type = response.headers.get("content-type") ?? "";
    if (type && !/html|text\/plain|xml/i.test(type)) return { ok: false, status: response.status, error: `not a web page (${type.split(";")[0]})` };
    const reader = response.body?.getReader();
    if (!reader) return { ok: false, status: response.status, error: "empty response" };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
      if (size > MAX_HTML_BYTES) { await reader.cancel().catch(() => {}); break; }
    }
    const html = new TextDecoder().decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
    return { ok: response.ok, status: response.status, html, finalUrl: response.url || safe.href };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, error: /timeout|aborted/i.test(msg) ? "site took too long to answer" : /ENOTFOUND|getaddrinfo/i.test(msg) ? "domain does not resolve" : msg.slice(0, 120) };
  }
}

async function viaJina(url: string): Promise<{ title: string; description: string; text: string } | null> {
  const key = process.env.JINA_API_KEY;
  if (!key) return null;
  try {
    const response = await fetch(`https://r.jina.ai/${url}`, { headers: { Authorization: `Bearer ${key}`, Accept: "text/plain", "X-Return-Format": "text" }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) return null;
    const text = (await response.text()).slice(0, 8_000);
    return { title: "", description: "", text };
  } catch { return null; }
}

export type WebsiteRead = { ok: boolean; url: string; title?: string; description?: string; text?: string; chars?: number; pages?: string[]; via?: string; error?: string };

/**
 * A company's own words: the homepage, and the About page too when the homepage says too little. Returns a
 * reason rather than text whenever the page is a wall, an error or empty, so nothing unusable reaches the model.
 */
export async function readWebsite(url: string): Promise<WebsiteRead> {
  const home = await fetchHtml(url);
  let page = home.html ? htmlToText(home.html) : null;
  const why = home.ok && page ? unusablePage(page, home.status) : home.error || (home.status ? `HTTP ${home.status}` : "no response");
  const pages = [home.finalUrl || url];
  if (!why && page && page.text.length < 800) {
    const base = new URL(home.finalUrl || url);
    for (const path of ["/about", "/about-us"]) {
      const about = await fetchHtml(`${base.origin}${path}`);
      if (!about.ok || !about.html) continue;
      const extra = htmlToText(about.html, 5_000);
      if (!unusablePage(extra, about.status)) { page = { ...page, text: `${page.text}\n\n${extra.text}`.slice(0, 8_000) }; pages.push(`${base.origin}${path}`); break; }
    }
  }
  if (why) {
    const jina = await viaJina(url);
    if (jina && !unusablePage(jina)) return { ok: true, url, ...jina, chars: jina.text.length, pages: [url], via: "jina" };
    return { ok: false, url, error: why };
  }
  return { ok: true, url, title: page!.title, description: page!.description, text: page!.text, chars: page!.text.length, pages, via: "direct" };
}

/* ── LinkedIn via Bright Data ── */

export async function triggerProfiles(urls: string[]): Promise<{ ok: boolean; snapshot?: string; error?: string }> {
  const key = process.env.BRIGHTDATA_API_KEY;
  if (!key) return { ok: false, error: "BRIGHTDATA_API_KEY is not set, so LinkedIn profiles cannot be scraped." };
  try {
    const response = await fetch(`${brightDataBase()}/datasets/v3/trigger?dataset_id=${PROFILES_DATASET}&include_errors=true&format=json`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(urls.map((url) => ({ url }))),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.snapshot_id) return { ok: false, error: `Bright Data refused the batch: ${payload?.error ?? payload?.message ?? `HTTP ${response.status}`}` };
    return { ok: true, snapshot: String(payload.snapshot_id) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not reach Bright Data." };
  }
}

/** A triggered batch: not ready yet, or its records trimmed for the structuring model. */
export async function collectProfiles(snapshot: string): Promise<{ ok: boolean; ready?: boolean; records?: unknown[]; error?: string }> {
  const key = process.env.BRIGHTDATA_API_KEY;
  if (!key) return { ok: false, error: "BRIGHTDATA_API_KEY is not set." };
  if (!/^[a-z0-9_-]{4,80}$/i.test(snapshot)) return { ok: false, error: "Not a snapshot id." };
  try {
    const response = await fetch(`${brightDataBase()}/datasets/v3/snapshot/${encodeURIComponent(snapshot)}?format=json`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(45_000) });
    if (response.status === 202) return { ok: true, ready: false };
    const payload = await response.json().catch(() => null);
    if (!response.ok) return { ok: false, error: `Bright Data: ${(payload as { error?: string })?.error ?? `HTTP ${response.status}`}` };
    const list = Array.isArray(payload) ? payload : [];
    return {
      ok: true,
      ready: true,
      records: list.map((rec: Record<string, unknown>) => {
        const input = (rec?.input as { url?: string } | undefined)?.url ?? rec?.input_url ?? rec?.url;
        const error = rec?.error || rec?.error_code ? String(rec.error ?? rec.error_code) : "";
        return { input, error, record: error ? null : trimLinkedinRecord(rec) };
      }),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Could not reach Bright Data." };
  }
}

/* ── Structuring ── */

export type StructureBatch =
  | { ok: true; rows: Map<number, Record<string, unknown>>; cost: number | null; tokens: number; model: string }
  | { ok: false; rateLimited: true; retryAfterMs: number; error: string }
  | { ok: false; rateLimited?: false; error: string };

/**
 * Several rows' scraped sources → their fixed fields, in one OpenRouter call.
 *
 * Reasoning is off: this is transcription, and in testing "none" halved the latency (≈3s vs ≈7s) and the cost
 * with the same fields filled. Strict JSON schema, so the answer always parses; temperature 0, so the same page
 * gives the same facts.
 *
 * A 429 is returned to the caller at once rather than retried here. OpenRouter's limit is per minute — the live
 * run hit "new accounts are limited to 20 requests per minute" — so retrying inside the request only burns the
 * minute; the browser holds the batch and resends it when the window has passed.
 */
export async function structureBatch(mode: "contacts" | "companies", items: Array<{ i: number; profile: unknown; source: Record<string, unknown> }>): Promise<StructureBatch> {
  const first = await structureOnce(mode, items);
  // A cut-off answer (one long About section can use the whole budget) is retried as two halves rather than
  // failing six rows. Seen once in live testing; halves always fit.
  if (!first.ok && !first.rateLimited && first.error.startsWith(TRUNCATED) && items.length > 1) {
    const mid = Math.ceil(items.length / 2);
    const [a, b] = [await structureBatch(mode, items.slice(0, mid)), await structureBatch(mode, items.slice(mid))];
    if (a.ok && b.ok) return { ok: true, rows: new Map([...a.rows, ...b.rows]), cost: (a.cost ?? 0) + (b.cost ?? 0), tokens: a.tokens + b.tokens, model: a.model };
    return !a.ok ? a : b;
  }
  return first;
}

const TRUNCATED = "The model's answer was cut off";

async function structureOnce(mode: "contacts" | "companies", items: Array<{ i: number; profile: unknown; source: Record<string, unknown> }>): Promise<StructureBatch> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return { ok: false, error: "OPENROUTER_API_KEY is not set." };
  const model = enrichConfig().structureModel;
  const body = JSON.stringify({
    model,
    temperature: 0,
    reasoning: { effort: "none" },
    // ~350 output tokens a row with evidence, and headroom for a long About section.
    max_tokens: Math.min(12_000, 900 * items.length + 500),
    response_format: { type: "json_schema", json_schema: { name: mode === "companies" ? "company_facts" : "person_facts", strict: true, schema: structureBatchSchema(mode) } },
    messages: [
      { role: "system", content: batchPrompt(mode) },
      { role: "user", content: structureBatchInput(mode, items) },
    ],
  });
  let last = "";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(50_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 429) {
        const after = Number(response.headers.get("retry-after"));
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const retryAfterMs = Number.isFinite(after) && after > 0 ? after * 1000 : Number.isFinite(reset) && reset > Date.now() ? reset - Date.now() : 30_000;
        return { ok: false, rateLimited: true, retryAfterMs: Math.min(Math.max(retryAfterMs, 5_000), 90_000), error: String(payload?.error?.message ?? "Rate limited by OpenRouter").slice(0, 300) };
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (response.ok && content) {
        let parsed: unknown;
        const cut = payload?.choices?.[0]?.finish_reason === "length";
        try { parsed = JSON.parse(content); } catch { return { ok: false, error: cut ? `${TRUNCATED}.` : "The model's answer was not valid JSON." }; }
        const cost = Number(payload?.usage?.cost);
        return { ok: true, rows: splitBatchAnswer(parsed, items.map((it) => it.i)) as Map<number, Record<string, unknown>>, cost: Number.isFinite(cost) ? cost : null, tokens: Number(payload?.usage?.total_tokens) || 0, model: String(payload?.model ?? model) };
      }
      last = `${model} ${response.status}: ${payload?.error?.message ?? "no answer"}`.slice(0, 300);
      if (response.status < 500) break;
    } catch (error) {
      last = error instanceof Error ? error.message : "Could not reach OpenRouter.";
    }
    await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
  }
  return { ok: false, error: last || "The structuring model did not answer." };
}
