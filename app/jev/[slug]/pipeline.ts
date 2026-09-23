// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The browser side of the Jev pipeline: first pass → scrape → structure → final pass, run over chunks of the
 * file with several chunks in flight. Holds no React state — it reports every step through hooks, and the page
 * decides what to draw.
 *
 * ── Why the browser drives it ────────────────────────────────────────────────────────────────────
 * Each server route does one short, bounded thing (classify 40 rows, read 12 sites, structure 6 rows, look up
 * 100 contacts in AI Ark) and returns inside Vercel's 60s ceiling. A 5,000-contact run is many of those,
 * sequenced here, with the table and stage counters updating as each one lands.
 *
 * ── Why chunks are pipelined rather than staged ──────────────────────────────────────────────────
 * Scraping is the slow part. Staging it (scrape everything, then structure everything) would show nothing for
 * the first twenty minutes of a big company run. Pipelined, the first chunk is fully classified while later
 * chunks are still being read, and the counters show every stage moving at once.
 */
import { afterFirstPass, aiArkEvidence, evidenceOf, mergeAiArk, mergeStructured } from "../../../shared/enrich.mjs";

export type Mode = "contacts" | "companies";
export type EnrichMode = "auto" | "all" | "off";
export type Stage = "first" | "scrape" | "structure" | "final";
export type Source = { kind: "website" | "aiark"; url: string; title?: string; description?: string; text?: string; record?: unknown; chars?: number; pages?: string[]; via?: string };
export type Enriched = { profile: unknown; filled: string[]; evidence: { field: string; quote: string }[]; source: Omit<Source, "text" | "record">; structured: Record<string, unknown>; cost: number | null };
export type Outcome = { i: number; result: Record<string, unknown>; first?: Record<string, unknown> | null; enriched: boolean; note: string };
export type StageStats = { queued: number; active: number; done: number; failed: number; skipped: number; cost: number; credits?: number; waitUntil?: number };
export type PipelineStats = Record<Stage, StageStats> & { tokens: number; jevCost: number };
export type LogKind = "info" | "ok" | "warn" | "error";

export const freshStats = (): PipelineStats => ({
  first: { queued: 0, active: 0, done: 0, failed: 0, skipped: 0, cost: 0 },
  scrape: { queued: 0, active: 0, done: 0, failed: 0, skipped: 0, cost: 0 },
  structure: { queued: 0, active: 0, done: 0, failed: 0, skipped: 0, cost: 0 },
  final: { queued: 0, active: 0, done: 0, failed: 0, skipped: 0, cost: 0 },
  tokens: 0,
  jevCost: 0,
});

export type Hooks = {
  client: string;
  mode: Mode;
  enrichMode: EnrichMode;
  /** AI Ark is configured, so contacts can be looked up. */
  aiArk: boolean;
  /** Structuring requests a minute, shared by every lane — OpenRouter's limit is per account, not per request. */
  structureRpm: number;
  signal: AbortSignal;
  stats: PipelineStats;
  profileOf: (i: number) => unknown;
  nameOf: (i: number) => string;
  targetOf: (i: number) => string;
  missingOf: (i: number, profile: unknown) => string[];
  cached: Map<number, Enriched>;
  onStage: (i: number, stage: Stage | null) => void;
  onEnriched: (i: number, e: Enriched) => void;
  onSettle: (o: Outcome) => void;
  onLog: (kind: LogKind, text: string) => void;
  onChange: () => void;
};

/** Rows per chunk and chunks in flight. A contact chunk is two AI Ark calls (100 people each) and two lanes stay
 *  well under AI Ark's 5 requests a second; company chunks are small so websites stream in quickly. */
const CHUNK: Record<Mode, number> = { contacts: 200, companies: 40 };
const LANES: Record<Mode, number> = { contacts: 2, companies: 6 };
const PEOPLE_BATCH = 100;
const CLASSIFY_BATCH = 40;
const SITE_BATCH = 12;
/** Rows per structuring call. Six keeps a call's output well inside the 60s function ceiling (~20s at Luna's speed). */
const STRUCTURE_BATCH = 6;
const MAX_RATE_WAITS = 40;
const PARALLEL = 3;
/** AI Ark bills People Search per result returned; a URL it does not know costs nothing. */
export const AI_ARK_CREDITS_PER_PERSON = 0.5;

class Fatal extends Error {}

/** Spaces requests evenly to stay under a per-minute cap, and holds everything back after a 429. */
function makeLimiter(rpm: number) {
  const gap = 60_000 / Math.max(1, rpm);
  let nextAt = 0;
  return {
    async take(signal: AbortSignal) {
      const now = Date.now();
      const at = Math.max(now, nextAt);
      nextAt = at + gap;
      if (at > now) await sleep(at - now, signal);
    },
    pause(ms: number) { nextAt = Math.max(nextAt, Date.now() + ms); },
  };
}
type Limiter = ReturnType<typeof makeLimiter>;
let limiter: Limiter = makeLimiter(18);

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
});

async function each<T>(items: T[], size: number, parallel: number, fn: (batch: T[]) => Promise<void>) {
  const batches: T[][] = [];
  for (let k = 0; k < items.length; k += size) batches.push(items.slice(k, k + size));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, batches.length) }, async () => { while (next < batches.length) await fn(batches[next++]); }));
}

/** POST and read an NDJSON stream line by line. Throws `Fatal` on the failures that would repeat on every call. */
async function stream(url: string, body: unknown, signal: AbortSignal, onLine: (line: Record<string, unknown>) => void) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  if (!response.ok || !response.body) {
    const payload = await response.json().catch(() => ({}));
    const message = String(payload?.error || `Request failed (${response.status}).`);
    if (response.status === 400 || response.status === 401 || response.status === 409) throw new Fatal(message);
    throw new Error(message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
      if (!line) continue;
      // Only the parse is guarded: a handler that throws (a Fatal, say) must reach the caller, not vanish here.
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line); } catch { continue; /* one malformed line is one row, reported as unanswered */ }
      onLine(parsed);
    }
  }
}

/** Jev over a set of rows, each with the profile given. Returns what came back, keyed by row. */
async function classify(h: Hooks, rows: number[], profileOf: (i: number) => unknown, stage: "first" | "final"): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  const st = h.stats[stage];
  st.queued += rows.length; h.onChange();
  await each(rows, CLASSIFY_BATCH, PARALLEL, async (batch) => {
    st.queued -= batch.length; st.active += batch.length; h.onChange();
    try {
      await stream("/api/jev/classify", { client: h.client, mode: h.mode, rows: batch.map((i) => ({ i, state: profileOf(i) })) }, h.signal, (line) => {
        const i = Number(line.i);
        out.set(i, line);
        st.active -= 1;
        if (line.ok) {
          st.done += 1;
          h.stats.tokens += Number(line.tokens) || 0;
          const c = Number(line.cost); h.stats.jevCost += Number.isFinite(c) ? c : (Number(line.tokens) || 0) * 0.042e-6;
        } else {
          st.failed += 1;
          if (/OPENROUTER_API_KEY|401|403/.test(String(line.error))) throw new Fatal(String(line.error));
        }
        h.onChange();
      });
    } catch (error) {
      if (error instanceof Fatal || h.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : "Connection dropped.";
      for (const i of batch) if (!out.has(i)) { out.set(i, { i, ok: false, error: message }); st.active -= 1; st.failed += 1; }
      h.onLog("error", `Jev ${stage === "first" ? "first" : "final"} pass failed for ${batch.length} rows: ${message}`);
      h.onChange();
    }
    for (const i of batch) if (!out.has(i)) { out.set(i, { i, ok: false, error: "No answer came back for this row." }); st.active -= 1; st.failed += 1; }
  });
  return out;
}

/** Websites for a set of company rows, read on the server, a dozen at a time. */
async function scrapeSites(h: Hooks, rows: number[], onSource: (i: number, s: Source) => void, onFail: (i: number, why: string) => void) {
  const st = h.stats.scrape;
  await each(rows, SITE_BATCH, PARALLEL, async (batch) => {
    for (const i of batch) h.onStage(i, "scrape");
    st.queued -= batch.length; st.active += batch.length; h.onChange();
    const seen = new Set<number>();
    try {
      await stream("/api/jev/scrape", { mode: "companies", items: batch.map((i) => ({ i, url: h.targetOf(i) })) }, h.signal, (line) => {
        const i = Number(line.i); seen.add(i); st.active -= 1;
        if (line.ok) {
          st.done += 1;
          h.onLog("ok", `Read ${String(line.url).replace(/^https:\/\//, "")} — ${Number(line.chars).toLocaleString()} chars${Array.isArray(line.pages) && line.pages.length > 1 ? " (home + about)" : ""}${line.via === "jina" ? " via Jina" : ""}`);
          onSource(i, { kind: "website", url: String(line.url), title: String(line.title ?? ""), description: String(line.description ?? ""), text: String(line.text ?? ""), chars: Number(line.chars) || 0, pages: line.pages as string[], via: String(line.via ?? "") });
        } else {
          st.failed += 1;
          h.onLog("warn", `Couldn't read ${String(line.url ?? h.targetOf(i)).replace(/^https:\/\//, "")} — ${line.error}`);
          onFail(i, `Couldn't read the website: ${line.error}`);
        }
        h.onChange();
      });
    } catch (error) {
      if (error instanceof Fatal || h.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : "Connection dropped.";
      for (const i of batch) if (!seen.has(i)) { seen.add(i); st.active -= 1; st.failed += 1; onFail(i, `Couldn't read the website: ${message}`); }
    }
    for (const i of batch) if (!seen.has(i)) { st.active -= 1; st.failed += 1; onFail(i, "The website read did not come back."); }
    h.onChange();
  });
}

/**
 * Contacts looked up in AI Ark, a hundred a call. AI Ark's record is already structured, so each found contact is
 * merged straight into its profile here — contacts never go through the structuring model.
 */
async function lookupContacts(h: Hooks, rows: number[], onEnriched: (i: number, e: Enriched) => void, onFail: (i: number, why: string) => void) {
  const st = h.stats.scrape;
  await each(rows, PEOPLE_BATCH, 2, async (batch) => {
    for (const i of batch) h.onStage(i, "scrape");
    st.queued -= batch.length; st.active += batch.length; h.onChange();
    const seen = new Set<number>();
    let found = 0;
    try {
      await stream("/api/jev/scrape", { mode: "contacts", items: batch.map((i) => ({ i, url: h.targetOf(i) })) }, h.signal, (line) => {
        const i = Number(line.i); if (seen.has(i)) return; seen.add(i); st.active -= 1;
        if (line.ok && line.person) {
          st.done += 1; found += 1;
          st.credits = (st.credits ?? 0) + AI_ARK_CREDITS_PER_PERSON;
          const { profile, filled, facts } = mergeAiArk(h.profileOf(i), line.person) as { profile: unknown; filled: string[]; facts: Record<string, unknown> };
          onEnriched(i, { profile, filled, evidence: aiArkEvidence(facts), source: { kind: "aiark", url: String(line.url), via: "aiark" }, structured: facts, cost: null });
        } else {
          st.failed += 1;
          onFail(i, line.error === "not in AI Ark" ? "Not in AI Ark — judged on the list's own data" : `AI Ark lookup failed: ${line.error}`);
        }
        h.onChange();
      });
    } catch (error) {
      if (error instanceof Fatal || h.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : "Connection dropped.";
      for (const i of batch) if (!seen.has(i)) { seen.add(i); st.active -= 1; st.failed += 1; onFail(i, `AI Ark lookup failed: ${message}`); }
    }
    for (const i of batch) if (!seen.has(i)) { st.active -= 1; st.failed += 1; onFail(i, "The AI Ark lookup did not come back."); }
    h.onLog(found ? "ok" : "warn", `AI Ark — ${found} of ${batch.length} contacts found${batch.length - found ? `, ${batch.length - found} not in AI Ark` : ""} · ${found * AI_ARK_CREDITS_PER_PERSON} credits`);
    h.onChange();
  });
}

/** The structuring model over scraped sources, a few rows a call, paced to the account's rate limit. */
async function structure(h: Hooks, items: Array<{ i: number; source: Source }>, onDone: (i: number, e: Enriched) => void, onFail: (i: number, why: string) => void) {
  const st = h.stats.structure;
  st.queued += items.length; h.onChange();
  await each(items, STRUCTURE_BATCH, PARALLEL, async (batch) => {
    for (const { i } of batch) h.onStage(i, "structure");
    const seen = new Set<number>();
    const byI = new Map(batch.map((b) => [b.i, b]));
    let waits = 0;
    let started = false;
    for (;;) {
      await limiter.take(h.signal);
      if (h.signal.aborted) return;
      if (!started) { st.queued -= batch.length; st.active += batch.length; started = true; h.onChange(); }
      let limited: { retryAfterMs: number; error: string } | null = null;
      try {
        await stream("/api/jev/structure", { mode: h.mode, items: batch.map(({ i, source }) => ({ i, profile: h.profileOf(i), source })) }, h.signal, (line) => {
          if (line.rateLimited) { limited = { retryAfterMs: Number(line.retryAfterMs) || 30_000, error: String(line.error ?? "") }; return; }
          const i = Number(line.i); if (seen.has(i)) return; seen.add(i); st.active -= 1;
          const item = byI.get(i);
          if (line.ok && item) {
            st.done += 1;
            const c = Number(line.cost); if (Number.isFinite(c)) st.cost += c;
            const structured = (line.structured ?? {}) as Record<string, unknown>;
            const { profile, filled } = mergeStructured(h.mode, h.profileOf(i), structured) as { profile: unknown; filled: string[] };
            const { text: _text, record: _record, ...source } = item.source;
            void _text; void _record;
            h.onLog(filled.length ? "ok" : "warn", `Structured ${h.nameOf(i)} — ${filled.length ? `${filled.length} field${filled.length === 1 ? "" : "s"} (${filled.join(", ")})` : "nothing usable in the source"}`);
            onDone(i, { profile, filled, evidence: evidenceOf(structured), source, structured, cost: Number.isFinite(c) ? c : null });
          } else {
            st.failed += 1;
            h.onLog("error", `Couldn't structure ${h.nameOf(i)} — ${line.error}`);
            onFail(i, `Structuring failed: ${line.error}`);
          }
          h.onChange();
        });
      } catch (error) {
        if (error instanceof Fatal || h.signal.aborted) throw error;
        const message = error instanceof Error ? error.message : "Connection dropped.";
        for (const { i } of batch) if (!seen.has(i)) { seen.add(i); st.active -= 1; st.failed += 1; onFail(i, `Structuring failed: ${message}`); }
      }
      const hit = limited as { retryAfterMs: number; error: string } | null;
      if (hit && waits < MAX_RATE_WAITS) {
        waits += 1;
        limiter.pause(hit.retryAfterMs);
        st.waitUntil = Date.now() + hit.retryAfterMs;
        h.onLog("warn", `OpenRouter rate limit — holding ${batch.length} rows for ${Math.round(hit.retryAfterMs / 1000)}s`);
        h.onChange();
        continue;
      }
      if (hit) for (const { i } of batch) if (!seen.has(i)) { seen.add(i); st.active -= 1; st.failed += 1; onFail(i, `Structuring failed: still rate limited after ${waits} waits`); }
      break;
    }
    if (st.waitUntil && st.waitUntil < Date.now()) st.waitUntil = undefined;
    for (const { i } of batch) if (!seen.has(i)) { st.active -= 1; st.failed += 1; onFail(i, "The structuring answer did not come back."); }
    h.onChange();
  });
}

/** One chunk, end to end. */
async function runChunk(h: Hooks, chunk: number[]) {
  const settled = new Set<number>();
  const settle = (o: Outcome) => { if (settled.has(o.i)) return; settled.add(o.i); h.onStage(o.i, null); h.onSettle(o); };
  const cached = chunk.filter((i) => h.cached.has(i));
  const fresh = chunk.filter((i) => !h.cached.has(i));

  // 1. First pass on the list's own data — skipped when every row is going to be scraped anyway.
  let first = new Map<number, Record<string, unknown>>();
  if (h.enrichMode !== "all" && fresh.length) {
    for (const i of fresh) h.onStage(i, "first");
    first = await classify(h, fresh, h.profileOf, "first");
  }
  const toScrape: number[] = [];
  let decided = 0; let ruledOut = 0; let noTarget = 0;
  for (const i of fresh) {
    const r = first.get(i) ?? null;
    const route = afterFirstPass(h.mode, r?.ok ? r : null, h.missingOf(i, h.profileOf(i)), h.enrichMode);
    if (route === "decided" || route === "ruled_out") {
      if (route === "ruled_out") ruledOut += 1; else decided += 1;
      settle({ i, result: r ?? { ok: false, error: "No answer" }, first: r, enriched: false, note: route === "ruled_out" ? "Ruled out on the list's own data — not scraped" : "" });
    } else if (!h.targetOf(i)) {
      noTarget += 1;
      settle({ i, result: r ?? { ok: false, error: "No answer" }, first: r, enriched: false, note: h.mode === "companies" ? "Needs more data, but the row has no website to read" : "Needs more data, but the row has no LinkedIn profile URL" });
    } else if (h.mode === "contacts" && !h.aiArk) {
      noTarget += 1;
      settle({ i, result: r ?? { ok: false, error: "No answer" }, first: r, enriched: false, note: "Needs more data — AI Ark is not set up (AI_ARK_API_KEY)" });
    } else toScrape.push(i);
  }
  if (fresh.length && h.enrichMode !== "all") {
    h.onLog("info", `First pass on ${fresh.length} rows — ${decided} decided, ${ruledOut} ruled out, ${toScrape.length} to enrich${noTarget ? `, ${noTarget} need data but can't be scraped` : ""}`);
  }
  h.stats.scrape.skipped += decided + ruledOut + noTarget;
  h.stats.scrape.queued += toScrape.length; h.onChange();

  // 2–3. Scrape, then structure as each source lands.
  const sources: Array<{ i: number; source: Source }> = [];
  const fallback = (i: number, why: string) => {
    const r = first.get(i) ?? null;
    settle({ i, result: r?.ok ? r : { ok: false, error: why }, first: r, enriched: false, note: why });
  };
  const ready: number[] = [...cached];
  if (toScrape.length) {
    if (h.mode === "companies") await scrapeSites(h, toScrape, (i, s) => sources.push({ i, source: s }), fallback);
    else await lookupContacts(h, toScrape, (i, e) => { h.cached.set(i, e); h.onEnriched(i, e); ready.push(i); }, fallback);
  }
  if (sources.length) {
    await structure(h, sources, (i, e) => { h.cached.set(i, e); h.onEnriched(i, e); ready.push(i); }, fallback);
  }

  // 4. Final pass on the enriched profiles.
  if (ready.length) {
    for (const i of ready) h.onStage(i, "final");
    const finals = await classify(h, ready, (i) => h.cached.get(i)?.profile ?? h.profileOf(i), "final");
    for (const i of ready) {
      const r = finals.get(i) ?? { ok: false, error: "No answer" };
      settle({ i, result: r, first: first.get(i) ?? null, enriched: true, note: "" });
    }
  }
}

/** The whole run. Resolves when every row has settled, the run was stopped, or a failure made going on pointless. */
export async function runPipeline(h: Hooks, rows: number[]): Promise<{ fatal?: string }> {
  const size = CHUNK[h.mode];
  limiter = makeLimiter(h.structureRpm);
  const chunks: number[][] = [];
  for (let k = 0; k < rows.length; k += size) chunks.push(rows.slice(k, k + size));
  let next = 0;
  let fatal: string | undefined;
  h.onLog("info", `Run started — ${rows.length.toLocaleString()} rows, enrichment ${h.enrichMode === "auto" ? "only where needed" : h.enrichMode === "all" ? "on every row" : "off"}`);
  await Promise.all(Array.from({ length: Math.min(LANES[h.mode], chunks.length) }, async () => {
    while (!fatal && !h.signal.aborted && next < chunks.length) {
      try { await runChunk(h, chunks[next++]); } catch (error) {
        if (h.signal.aborted) return;
        fatal = error instanceof Error ? error.message : "The run failed.";
        h.onLog("error", `Stopped: ${fatal}`);
      }
    }
  }));
  return { fatal };
}
