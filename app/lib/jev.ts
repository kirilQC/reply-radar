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
import { mergeNamedTags, normalizeQuestionSet, normalizeTagSet, parseGeneratedQuestionSet, parseGeneratedTagSet, parseTagList, toWireQuestions } from "../../shared/jev.mjs";

type Row = Record<string, unknown>;
export type JevQuestion = { key: string; label: string; type: "noul" | "choice"; instructions: string; criteria?: Record<string, string>; pass: boolean | string[] };
export type JevQuestionSet = { questions: JevQuestion[]; thresholds: { keep: number; drop: number }; source?: string; updatedAt?: string; brainFolder?: string; brainDocuments?: string[]; brief?: string };
export type JevTag = { key: string; label: string; description: string };
export type JevTagSet = { instructions: string; tags: JevTag[]; minConfidence: number; source?: string; updatedAt?: string; brief?: string };
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
/** Company tagging is stored beside the contact questions, one key per client, so each client has one of each. */
export const tagSetKey = (slug: string) => `jev_tags_${slug}`;

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
    brief: text(meta.brief) || undefined,
  };
}

export async function loadTagSet(slug: string): Promise<JevTagSet | null> {
  const raw = await readConfig(tagSetKey(slug));
  const value = typeof raw === "string" ? (() => { try { return JSON.parse(raw); } catch { return null; } })() : raw;
  if (!value || typeof value !== "object") return null;
  const { instructions, tags, minConfidence } = normalizeTagSet(value);
  if (!tags.length) return null;
  const meta = value as Row;
  return { instructions, tags: tags as JevTag[], minConfidence, source: text(meta.source) || undefined, updatedAt: text(meta.updatedAt) || undefined, brief: text(meta.brief) || undefined };
}

export async function saveTagSet(slug: string, input: unknown, source = "manual"): Promise<{ set: JevTagSet; problems: string[] }> {
  const { instructions, tags, minConfidence, problems } = normalizeTagSet(input);
  const meta = (input && typeof input === "object" ? input : {}) as Row;
  const set: JevTagSet = { instructions, tags: tags as JevTag[], minConfidence, source, updatedAt: new Date().toISOString(), ...(text(meta.brief) ? { brief: text(meta.brief).slice(0, 4_000) } : {}) };
  if (tags.length) await writeConfig(tagSetKey(slug), set);
  return { set, problems };
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
    ...(text(meta.brief) ? { brief: text(meta.brief).slice(0, 4_000) } : {}),
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
- When the person running the list has described what they want, build from that description first; use the client's ICP below only to fill in what they left unsaid. Otherwise base every question on the ICP as written. Do not invent targeting neither supports.
- 4 to 7 questions. The first should usually check that the listed company is the person's main current job.

Reply with JSON only, no prose, in exactly this shape:
{"questions":[{"label":"Short name shown to the engineer","type":"noul","instructions":"…","criteria":{"true":"…","false":"…"},"pass":true},{"label":"…","type":"choice","instructions":"…","criteria":{"option_key":"description", "unclear":"The profile does not say"},"pass":["option_key"]}]}`;

const TAG_PROMPT = `You design the category set a fast classification model (TypeSafe's Jev) uses to tag a list of companies for QC Growth, a B2B outbound agency. Off-the-shelf GTM tools stop at labels like "mental health care" or "hospitals and health care"; the point of this is to sort companies far more finely than that.

Jev does not write or reason step by step. For every company it reads a compact JSON profile — name, industry, description, products, employees, locations, type, funding, revenue, location, other — and picks exactly one of your tags, with a probability for each.

What makes this accurate:
- Every tag gets a plain-language description saying what belongs in it, written for someone who has never heard the term — one sentence, at most 30 words, so a 40-tag set is written quickly. Neighbouring tags must say how they differ ("part of a multi-hospital system" vs "a single independent hospital"). Put the boundary cases in the description.
- Literal wording. Jev answers the words you wrote. No arithmetic or thresholds it would have to compute — "a large system with many hospitals" rather than "more than 5 hospitals".
- Keep the person's tag names exactly as they gave them, in their order. If they gave no list, propose one that fits their description, 5 to 40 tags.
- Always end with an "Other" tag for companies none of the tags fits (including organisations that are not what the list is about at all — a chess club, a conference, an investor).
- "instructions" is the single question Jev answers, e.g. "Which category best describes what this organization primarily is?". Mention what to do when a company fits two ("choose its primary business").

Reply with JSON only, no prose, in exactly this shape:
{"instructions":"…","tags":[{"label":"Tag name","description":"…"}]}`;

async function askSonnet(system: string, content: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY is not set." };
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      // A 40-tag set at one sentence each is ~2k tokens of output, which Sonnet writes in well under the
      // function's 60s ceiling; the cap and the timeout are the backstop, not the plan.
      body: JSON.stringify({ model: GENERATOR_MODEL, max_tokens: 6_000, temperature: 0, system, messages: [{ role: "user", content }] }),
      signal: AbortSignal.timeout(52_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: `Anthropic refused the build: ${payload?.error?.message ?? `HTTP ${response.status}`}` };
    const reply = Array.isArray(payload?.content) ? payload.content.filter((p: { type?: string }) => p?.type === "text").map((p: { text?: string }) => String(p.text ?? "")).join("") : "";
    return { ok: true, text: reply };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The build call failed." };
  }
}

/**
 * Turn a plain-language description into the Jev setup for one client: screening questions for a contact list,
 * or a tag set for a company list. The description is what the person asked for and it leads; the client's QC
 * Brain and brief sit behind it as background, so "only hospital CFOs" is not overridden by a broader ICP.
 *
 * A company tag list typed as "A | B | C" is taken literally — every tag the person named is kept, in order —
 * and the model only writes the descriptions that let Jev tell neighbours apart.
 */
export async function buildFromDescription(slug: string, mode: "contacts" | "companies", description: string, sampleProfile: unknown): Promise<{ ok: boolean; error?: string; set?: JevQuestionSet | JevTagSet; problems?: string[] }> {
  const brief = text(description).slice(0, 4_000);
  if (!brief) return { ok: false, error: "Describe how the list should be judged first." };
  const [row] = await workspaceRows(`slug=eq.${encodeURIComponent(slug)}&limit=1`);
  if (!row) return { ok: false, error: "Unknown client." };
  const name = text(row.name);
  const [brain, clientBrief] = await Promise.all([
    brainContext({ slug, name, brain_folder: text(row.brain_folder) || null }),
    clientContext(slug),
  ]);
  const sample = sampleProfile && typeof sampleProfile === "object" ? JSON.stringify(sampleProfile, null, 2).slice(0, 6_000) : "";
  const named = mode === "companies" ? parseTagList(brief) : [];
  const content = [
    `Client: ${name}`,
    `WHAT THE PERSON RUNNING THIS LIST ASKED FOR — this leads; everything below is background:\n${brief}`,
    named.length >= 3 ? `They named these tags; keep every one, spelled exactly so and in this order:\n${named.map((t: string) => `- ${t}`).join("\n")}` : "",
    clientBrief,
    brain.block,
    sample ? `A sample row, exactly as Jev will see it:\n${sample}` : "",
    mode === "companies" ? "Write the tag set now." : "Write the question set now.",
  ].filter(Boolean).join("\n\n");
  const reply = await askSonnet(mode === "companies" ? TAG_PROMPT : GENERATOR_PROMPT, content);
  if (!reply.ok) return { ok: false, error: reply.error };
  if (mode === "companies") {
    // Tags the person typed are kept exactly as typed; the model only supplies their descriptions.
    const parsed = mergeNamedTags(parseGeneratedTagSet(reply.text), named);
    if (!parsed.tags.length) return { ok: false, error: "The build came back without usable tags. Try again.", problems: parsed.problems };
    const { set, problems } = await saveTagSet(slug, { ...parsed, brief }, "description");
    return { ok: true, set, problems: [...parsed.problems, ...problems] };
  }
  const parsed = parseGeneratedQuestionSet(reply.text);
  if (!parsed.questions.length) return { ok: false, error: "The build came back without a usable question. Try again.", problems: parsed.problems };
  const { set, problems } = await saveQuestionSet(slug, { ...parsed, brief, brainFolder: brain.folder, brainDocuments: brain.documents }, "description");
  return { ok: true, set, problems: [...parsed.problems, ...problems] };
}

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
export async function evaluateOne(state: unknown, questions: JevQuestion[] | { wire: Record<string, unknown> }): Promise<{ ok: boolean; answers?: Record<string, JevAnswer>; tokens?: number; cost?: number | null; error?: string; status?: number }> {
  const { apiKey, endpoint, model } = jevConfig();
  if (!apiKey) return { ok: false, error: "OPENROUTER_API_KEY is not set." };
  const body = JSON.stringify({ model, state, questions: Array.isArray(questions) ? toWireQuestions(questions) : questions.wire });
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
