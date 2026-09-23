// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The I/O half of the Jev list checker: reaching Jev through OpenRouter, storing each client's question set,
 * and drafting that set from the client's QC Brain folder. Pure logic lives in `shared/jev.mjs`.
 *
 * ── Why OpenRouter's System One endpoint and not its chat endpoint ───────────────────────────────
 * Jev is not a chat model. OpenRouter serves it on `/api/v1/systemone`, a TypeSafe-shaped API that takes a
 * `state` and typed `questions`; the OpenAI-compatible `/chat/completions` does not accept it at all. The wire
 * format here is TypeSafe's own, so pointing `JEV_BASE_URL` at `https://api.typesafe.ai` with a TypeSafe key
 * works unchanged if we ever move off OpenRouter.
 *
 * ── Why the model is pinned ──────────────────────────────────────────────────────────────────────
 * The keep/drop thresholds are tuned against one model's probabilities. `jev-latest` would move under them
 * without anyone noticing, so the default is a named version and changing it is a deliberate act.
 *
 * ── Why a question set lives in rr_app_config ────────────────────────────────────────────────────
 * One key per client (`jev_questions_<slug>`), the same pattern as the per-client brief prompt, so it needs no
 * migration and a hard refresh always shows what the next run will use.
 */
import { clientContext } from "./client-context";
import { brainContext } from "./brain-context";
import { readConfig, writeConfig } from "./app-config";
import { normalizeQuestionSet, parseGeneratedQuestionSet, toWireQuestions } from "../../shared/jev.mjs";

type Row = Record<string, unknown>;
export type JevQuestion = { key: string; label: string; type: "noul" | "choice"; instructions: string; criteria?: Record<string, string>; pass: boolean | string[] };
export type JevQuestionSet = { questions: JevQuestion[]; thresholds: { keep: number; drop: number }; source?: string; updatedAt?: string; brainFolder?: string; brainDocuments?: string[] };
export type JevAnswer = { type: string; noul?: number; choice?: string; probabilities?: Record<string, number>; confidence?: number };

const DEFAULT_MODEL = "jev-1.13";
const DEFAULT_BASE_URL = "https://openrouter.ai/api";
const GENERATOR_MODEL = "claude-sonnet-4-6";
/** Jev answers in ~70–500ms; anything past this is a stuck connection, not a slow answer. */
const REQUEST_TIMEOUT_MS = 20_000;
/** 429 and 529 are TypeSafe's "back off and retry"; five tries with backoff rides out a burst. */
const MAX_ATTEMPTS = 5;

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
export const questionSetKey = (slug: string) => `jev_questions_${slug}`;

export function jevConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.TYPESAFE_API_KEY || "";
  const base = (process.env.JEV_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { apiKey, endpoint: `${base}/v1/systemone`, model: process.env.JEV_MODEL || DEFAULT_MODEL };
}

/* ── Workspaces ── */

export type JevClient = { id: string; name: string; slug: string; logoUrl: string | null; accentColor: string | null; brainFolder: string; hasQuestions: boolean; questionCount: number };

async function supabase(path: string) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" }).catch(() => null);
}

async function workspaceRows(filter: string): Promise<Row[]> {
  // `brain_folder` is an additive migration; without it the brain match falls back to slug and name.
  for (const columns of ["id,name,slug,logo_url,accent_color,brain_folder", "id,name,slug,logo_url,accent_color"]) {
    const response = await supabase(`rr_workspaces?select=${columns}&${filter}`);
    if (response?.ok) return ((await response.json().catch(() => [])) as Row[]) ?? [];
  }
  return [];
}

const shapeClient = (row: Row, set?: JevQuestionSet | null): JevClient => ({
  id: text(row.id),
  name: text(row.name),
  slug: text(row.slug),
  logoUrl: text(row.logo_url) || null,
  accentColor: text(row.accent_color) || null,
  brainFolder: text(row.brain_folder),
  hasQuestions: Boolean(set?.questions?.length),
  questionCount: set?.questions?.length ?? 0,
});

export async function listJevClients(): Promise<JevClient[]> {
  const rows = (await workspaceRows("slug=neq.misc&order=name.asc")).filter((row) => text(row.name));
  const sets = await Promise.all(rows.map((row) => loadQuestionSet(text(row.slug)).catch(() => null)));
  return rows.map((row, i) => shapeClient(row, sets[i]));
}

export async function jevClient(slug: string): Promise<JevClient | null> {
  const [row] = await workspaceRows(`slug=eq.${encodeURIComponent(slug)}&limit=1`);
  if (!row) return null;
  return shapeClient(row, await loadQuestionSet(slug).catch(() => null));
}

/* ── Question sets ── */

export async function loadQuestionSet(slug: string): Promise<JevQuestionSet | null> {
  const raw = await readConfig(questionSetKey(slug));
  const value = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!value || typeof value !== "object") return null;
  const { questions, thresholds } = normalizeQuestionSet(value);
  const meta = value as Row;
  return {
    questions: questions as JevQuestion[],
    thresholds,
    source: text(meta.source) || undefined,
    updatedAt: text(meta.updatedAt) || undefined,
    brainFolder: text(meta.brainFolder) || undefined,
    brainDocuments: Array.isArray(meta.brainDocuments) ? (meta.brainDocuments as unknown[]).map(String) : undefined,
  };
}

export async function saveQuestionSet(slug: string, input: unknown, source = "manual"): Promise<{ set: JevQuestionSet; problems: string[] }> {
  const { questions, thresholds, problems } = normalizeQuestionSet(input);
  const meta = (input && typeof input === "object" ? input : {}) as Row;
  const set: JevQuestionSet = {
    questions: questions as JevQuestion[],
    thresholds,
    source,
    updatedAt: new Date().toISOString(),
    ...(text(meta.brainFolder) ? { brainFolder: text(meta.brainFolder) } : {}),
    ...(Array.isArray(meta.brainDocuments) ? { brainDocuments: (meta.brainDocuments as unknown[]).map(String) } : {}),
  };
  await writeConfig(questionSetKey(slug), set);
  return { set, problems };
}

/* ── Drafting a question set from the brain ── */

const GENERATOR_PROMPT = `You design the screening questions a fast classification model (TypeSafe's Jev) uses to vet an outbound contact list for one client of QC Growth, a B2B outbound agency.

Jev does not write or reason step by step. For every contact it reads a compact JSON profile (the "state") and answers each of your questions independently, returning a probability. Your questions decide who is removed from the list, so a vague one deletes good leads or keeps bad ones.

The problem being solved: lists pulled from Clay or Sales Navigator contain contacts who reply "I don't work in that space" — people whose title looks right but whose real job is elsewhere, whose listed company is a side role (board seat, advisor, investor), who work at a vendor, agency or competitor, or who are too junior to buy.

Rules, from TypeSafe's own guidance on how Jev fails:
- One judgement per question. Never "senior AND in the right industry". Split it.
- Literal wording. Jev answers the words you wrote, not what you meant. State the exact condition and put boundary cases in the criteria.
- No arithmetic, counting or date comparison.
- Refer to profile fields by name in backticks. Every contact list, whatever tool exported it, is mapped onto this one profile shape, and a question set is reused across lists, so name only these fields:
  \`listed_title\`, \`listed_company\` — the title and company the list was pulled for
  \`headline\`, \`about\` — the person's own LinkedIn headline and About text
  \`seniority\`, \`department\`, \`location\`, \`skills\`
  \`current_roles\` — every job the person holds now: title, company, since, about
  \`listed_company_profile\` — .industry, .employees, .description, .products, .funding, .revenue, .location, .type
  \`other\` — unrecognised extra columns, by their original header
- Any field can be missing on a given list or contact. Write each question so a missing field leads to the "unclear" option (choice) or to the non-fit answer being unlikely either way — never so that absence reads as a fit. The sample profile shows which fields this client's current list actually carries; lean on those, but do not depend on a field only one exporter provides.
- Every question has exactly one answer that means "fits". For a noul (yes/no), prefer phrasing where yes = fits; set "pass": false only when a "no" is naturally the fit answer (e.g. "Is this company a competitor?"). Keep the criteria aligned with the instruction — never make "true" mean the bad outcome of a positively-worded question.
- For a choice, 3–6 options with plain-language descriptions, always including an "unclear" option for when the profile does not say. Mark only the genuinely fitting options in "pass"; "unclear" is not a fit.
- Base every question on the client's ICP as written below. Do not invent targeting the documents do not support.
- 4 to 7 questions. The first should usually check that the listed company is the person's main current job.

Reply with JSON only, no prose, in exactly this shape:
{"questions":[{"label":"Short name shown to the engineer","type":"noul","instructions":"…","criteria":{"true":"…","false":"…"},"pass":true},{"label":"…","type":"choice","instructions":"…","criteria":{"option_key":"description", "unclear":"The profile does not say"},"pass":["option_key"]}]}`;

export async function draftQuestionSet(slug: string, sampleProfile: unknown): Promise<{ ok: boolean; error?: string; set?: JevQuestionSet; problems?: string[]; brain?: { folder: string; documents: string[]; reason: string } }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY is not set." };
  const [row] = await workspaceRows(`slug=eq.${encodeURIComponent(slug)}&limit=1`);
  if (!row) return { ok: false, error: "Unknown client." };
  const name = text(row.name);
  const [brain, brief] = await Promise.all([
    brainContext({ slug, name, brain_folder: text(row.brain_folder) || null }),
    clientContext(slug),
  ]);
  if (!brain.block && !brief) {
    return { ok: false, error: brain.reason || `There is no QC Brain folder or client brief for ${name}, so there is no ICP to build questions from.` };
  }
  const sample = sampleProfile && typeof sampleProfile === "object" ? JSON.stringify(sampleProfile, null, 2).slice(0, 6_000) : "";
  const content = [
    `Client: ${name}`,
    brief,
    brain.block,
    sample
      ? `A sample contact profile, exactly as Jev will see it. Use only these field names:\n${sample}`
      : "No sample profile was provided. Refer to fields generically as the person's current role and the company's description.",
    "Write the question set now.",
  ].filter(Boolean).join("\n\n");
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: GENERATOR_MODEL, max_tokens: 4_000, temperature: 0, system: GENERATOR_PROMPT, messages: [{ role: "user", content }] }),
      signal: AbortSignal.timeout(50_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: `Anthropic refused the draft: ${payload?.error?.message ?? `HTTP ${response.status}`}` };
    const reply = Array.isArray(payload?.content) ? payload.content.filter((p: { type?: string }) => p?.type === "text").map((p: { text?: string }) => String(p.text ?? "")).join("") : "";
    const parsed = parseGeneratedQuestionSet(reply);
    if (!parsed.questions.length) return { ok: false, error: "The draft came back without a usable question. Try again.", problems: parsed.problems };
    const { set, problems } = await saveQuestionSet(slug, { ...parsed, brainFolder: brain.folder, brainDocuments: brain.documents }, "brain");
    return { ok: true, set, problems: [...parsed.problems, ...problems], brain: { folder: brain.folder, documents: brain.documents, reason: brain.reason } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The draft call failed." };
  }
}

/* ── Calling Jev ── */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One contact, every question, one request. Retries 429/529/5xx and network failures with jittered backoff;
 * a 4xx other than 429 is our fault (a malformed question) and retrying it only spends time.
 */
export async function evaluateOne(state: unknown, questions: JevQuestion[]): Promise<{ ok: boolean; answers?: Record<string, JevAnswer>; tokens?: number; cost?: number | null; error?: string; status?: number }> {
  const { apiKey, endpoint, model } = jevConfig();
  if (!apiKey) return { ok: false, error: "OPENROUTER_API_KEY is not set." };
  const body = JSON.stringify({ model, state, questions: toWireQuestions(questions) });
  let lastError = "";
  let lastStatus = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: `Bearer ${apiKey}` },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload?.answers) {
        const usage = payload.usage ?? {};
        const cost = Number(usage.cost);
        return { ok: true, answers: payload.answers, tokens: Number(usage.input_tokens ?? usage.prompt_tokens) || 0, cost: Number.isFinite(cost) ? cost : null };
      }
      lastStatus = response.status;
      const detail = payload?.error?.message ?? payload?.detail ?? payload?.message;
      lastError = `Jev ${response.status}${detail ? `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`.slice(0, 400);
      const retryable = response.status === 429 || response.status === 529 || response.status >= 500;
      if (!retryable) break;
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 8_000) : 400 * 2 ** attempt + Math.random() * 300);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Network error reaching Jev.";
      await sleep(400 * 2 ** attempt + Math.random() * 300);
    }
  }
  return { ok: false, error: lastError || "Jev did not answer.", status: lastStatus };
}
