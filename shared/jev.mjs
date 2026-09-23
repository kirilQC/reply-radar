// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The pure half of the Jev list checker: CSV in, one compact profile per contact, a validated question set,
 * and the verdict that combines Jev's answers. No I/O, so `tests/jev.test.mjs` drives all of it.
 *
 * ── Why the profile is trimmed rather than the whole row ─────────────────────────────────────────
 * An AI Ark export carries ~280 columns and ~1,500 tokens a row: fifteen past jobs, education, publications,
 * photo URLs, email-verification noise. TypeSafe's own jev-1.13 notes name "large state full of irrelevant
 * detail" as a failure mode — unrelated fields act as distractors and cost accuracy — and input tokens are the
 * only thing Jev charges for. So each row is cut to what decides fit (~380 tokens): who the person says they
 * are, the jobs they hold *now*, and what the company does.
 *
 * ── Why current roles are sent as a list ─────────────────────────────────────────────────────────
 * 37% of the sample export had more than one job marked current. The export picks one of them as "the"
 * company, and it is often the side role — a board seat, an advisory post — which is exactly how a list ends up
 * emailing someone about a company they do not really work at. Sending every current role lets a question ask
 * whether the listed company is the person's main job.
 *
 * ── Why a verdict is a gate, not a weighted sum ──────────────────────────────────────────────────
 * Each question is written so one answer is "fits". A contact is only a good fit when every question passes;
 * one clear fail is enough to drop them, and anything in between is borderline. Averaging would let a perfect
 * title paper over a company that is plainly a competitor, which is the kind of bad fit this exists to catch.
 */

/** Hard ceilings, so a malformed file or a runaway question set fails loudly rather than slowly. */
export const MAX_ROWS = 10_000;
export const MAX_QUESTIONS = 10;
export const MAX_CHOICE_OPTIONS = 255;
export const DEFAULT_THRESHOLDS = { keep: 0.6, drop: 0.35 };

const clip = (value, max) => {
  const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value == null ? "" : String(value).trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
};

/* ═══ CSV ═══ */

/**
 * RFC 4180 parsing: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, and a UTF-8 BOM.
 *
 * Hand-written because the repo takes no new dependencies, and because the naive `split(",")` is wrong on
 * exactly the columns that matter here — a LinkedIn About section is full of commas and line breaks.
 * Returns `{ headers, rows }` where each row is an object keyed by header. Blank lines are skipped.
 */
export function parseCsv(text, { asArrays = false } = {}) {
  const src = String(text ?? "").replace(/^\uFEFF/, "");
  /*
   * Fields are sliced out of the source by index, never built up a character at a time. `field += ch`
   * leaves V8 a rope of one-character pieces per field, and on a 5,000-row AI Ark export that was ~350MB
   * of heap in the browser for a 30MB file.
   */
  const records = [];
  let record = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    let value;
    if (src[i] === '"') {
      const parts = [];
      let start = i + 1;
      i = start;
      for (;;) {
        const q = src.indexOf('"', i);
        if (q < 0) { parts.push(src.slice(start)); i = n; break; }
        if (src[q + 1] === '"') { parts.push(src.slice(start, q + 1)); i = q + 2; start = i; continue; }
        parts.push(src.slice(start, q));
        i = q + 1;
        break;
      }
      value = parts.length === 1 ? parts[0] : parts.join("");
      // Anything between the closing quote and the next separator is kept, as a lenient parser would.
      let j = i;
      while (j < n && src[j] !== "," && src[j] !== "\n" && src[j] !== "\r") j += 1;
      if (j > i) value += src.slice(i, j);
      i = j;
    } else {
      let j = i;
      while (j < n && src[j] !== "," && src[j] !== "\n" && src[j] !== "\r") j += 1;
      value = src.slice(i, j);
      i = j;
    }
    record.push(value);
    if (i >= n) { records.push(record); break; }
    const sep = src[i];
    i += 1;
    if (sep === ",") { if (i >= n) { record.push(""); records.push(record); } continue; }
    if (sep === "\r" && src[i] === "\n") i += 1;
    records.push(record);
    record = [];
  }

  const nonEmpty = records.filter((r) => r.some((cell) => cell.trim() !== ""));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  // Duplicate header names are made unique rather than letting the second silently overwrite the first.
  const seen = new Map();
  const headers = nonEmpty[0].map((h, idx) => {
    const base = h.trim() || `Column ${idx + 1}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base} (${n + 1})` : base;
  });
  // `asArrays` keeps each row as its cells. An object with ~280 dynamically-added keys falls out of V8's fast
  // shape into a per-row hash table, which put a 5,000-row AI Ark export at ~380MB of heap in the browser.
  const body = nonEmpty.slice(1);
  if (asArrays) return { headers, rows: body.map((cells) => headers.map((_, idx) => cells[idx] ?? "")) };
  return { headers, rows: body.map((cells) => rowObject(headers, cells)) };
}

/** One row's cells as an object keyed by header, for code that reads columns by name. */
export function rowObject(headers, cells) {
  const row = {};
  headers.forEach((h, idx) => { row[h] = cells[idx] ?? ""; });
  return row;
}

/** Quote a value for CSV when it needs it. */
function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialise rows back to CSV with the given column order. Rows may be objects keyed by header, or cell arrays. */
export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) lines.push((Array.isArray(row) ? row : headers.map((h) => row[h])).map(csvCell).join(","));
  return lines.join("\r\n");
}

/* ═══ Profiles ═══ */

const ORDINALS = ["1st", "2nd", "3rd", ...Array.from({ length: 12 }, (_, i) => `${i + 4}th`)];

/** Whether a header row is an AI Ark contact export, which gets the structured profile below. */
export function isAiArkExport(headers) {
  const set = new Set(headers);
  return set.has("Headline") && set.has("1st Experience Title") && set.has("1st Experience is Current") && set.has("Company Description");
}

/** A normalised header, for matching loose column names across Sales Nav, Clay and hand-made files. */
const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Columns that never help decide fit, by normalised-name fragment. URLs, ids, contact details, verification
 * noise and photos: they cost tokens and act as distractors.
 */
const NOISE = ["url", "linkedin", "twitter", "facebook", "instagram", "email", "phone", "mobile", "mx", "domainsettings", "businessstatus", "emailprovider", "id", "picture", "photo", "avatar", "lastupdated", "dateofbirth", "followers", "zip", "postal", "address"];

/** Where a generic export's identity fields probably live, tried in order. */
const GENERIC_ALIASES = {
  name: ["fullname", "name", "contactname"],
  firstName: ["firstname"],
  lastName: ["lastname"],
  title: ["title", "jobtitle", "position", "currenttitle", "role"],
  company: ["company", "companyname", "organization", "organisation", "account", "accountname", "currentcompany"],
  linkedin: ["linkedin", "linkedinurl", "linkedinprofile", "linkedinprofileurl", "profileurl", "personlinkedinurl"],
};

function findColumn(headers, aliases) {
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  for (const alias of aliases) if (byNorm.has(alias)) return byNorm.get(alias);
  return "";
}

/**
 * Who a row is, for display and de-duplication — never sent to Jev. A person's name says nothing about fit and
 * is one more thing for the model to be swayed by.
 */
export function identify(row, headers) {
  const col = (key) => findColumn(headers, GENERIC_ALIASES[key]);
  const first = row[col("firstName")] ?? "";
  const last = row[col("lastName")] ?? "";
  const name = clip(row[col("name")] || `${first} ${last}`, 120);
  const linkedinCol = col("linkedin") || headers.find((h) => /linkedin/i.test(h) && !/company|experience/i.test(h)) || "";
  return {
    name: name || "(no name)",
    title: clip(row[col("title")], 160),
    company: clip(row[col("company")], 120),
    linkedin: clip(row[linkedinCol], 300),
  };
}

/** The profile Jev sees for one AI Ark row. Field names are the ones the questions refer to in backticks. */
function aiArkProfile(row) {
  const current = [];
  for (const o of ORDINALS) {
    if (row[`${o} Experience is Current`] !== "true") continue;
    const title = clip(row[`${o} Experience Title`], 140);
    const company = clip(row[`${o} Experience Company`], 120);
    if (!title && !company) continue;
    const role = { title, company };
    const since = clip(row[`${o} Experience Start Date`], 10);
    if (since) role.since = since;
    const about = clip(row[`${o} Experience Summary`], 280);
    if (about) role.about = about;
    current.push(role);
    if (current.length >= 4) break;
  }
  const profile = {
    listed_title: clip(row.Title, 160),
    listed_company: clip(row.Organization || row["Company Name"], 120),
    headline: clip(row.Headline, 220),
    about: clip(row.Summary, 600),
    seniority: clip(row.Seniority, 40),
    department: clip(row.Department, 60),
    current_roles: current,
    listed_company_profile: {
      industry: clip(row["Company Industry"], 80),
      employees: clip(row["Company Employee Count"], 20),
      description: clip(row["Company Description"], 500),
      products: clip(row["Company Product and Services"], 250),
      last_funding: clip(row["Company Last Funding Type"], 40),
      country: clip(row["Company Country"], 60),
    },
    location: clip(row.Location, 100),
  };
  return prune(profile);
}

/**
 * A generic row: every column that is not noise, trimmed, under a total budget. Used for Sales Nav, Clay and
 * anything hand-made, where there is no fixed schema to lean on.
 */
function genericProfile(row, headers) {
  const out = {};
  let spent = 0;
  const BUDGET = 3_000;
  for (const h of headers) {
    const n = norm(h);
    if (NOISE.some((frag) => n.includes(frag))) continue;
    if (GENERIC_ALIASES.name.includes(n) || GENERIC_ALIASES.firstName.includes(n) || GENERIC_ALIASES.lastName.includes(n)) continue;
    const value = clip(row[h], 600);
    if (!value) continue;
    if (spent + value.length > BUDGET) break;
    out[h] = value;
    spent += value.length;
  }
  return out;
}

/** Drop empty strings, empty arrays and empty objects, recursively, so absent data costs no tokens. */
function prune(value) {
  if (Array.isArray(value)) {
    const arr = value.map(prune).filter((v) => v !== undefined);
    return arr.length ? arr : undefined;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const p = prune(v);
      if (p !== undefined) out[k] = p;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value === "" || value == null ? undefined : value;
}

/** The state Jev evaluates for one row. */
export function profileFor(row, headers, format = isAiArkExport(headers) ? "aiark" : "generic") {
  return (format === "aiark" ? aiArkProfile(row) : genericProfile(row, headers)) ?? {};
}

/** Rough token estimate for display (4 characters a token is close enough to budget with). */
export const estimateTokens = (value) => Math.ceil(JSON.stringify(value ?? "").length / 4);

/**
 * Rows that are the same person as an earlier row, by LinkedIn URL (or name + company when there is no URL).
 * Decided in code, because it is exact and Jev charges for every row it sees.
 */
export function duplicateIndexes(people) {
  const seen = new Set();
  const dupes = new Set();
  people.forEach((p, i) => {
    const url = String(p.linkedin || "").toLowerCase().replace(/^https?:\/\/(www\.)?/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
    const key = url || `${String(p.name).toLowerCase()}|${String(p.company).toLowerCase()}`;
    if (!key || key === "(no name)|") return;
    if (seen.has(key)) dupes.add(i); else seen.add(key);
  });
  return dupes;
}

/* ═══ Question sets ═══ */

const slugKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

/**
 * A question set as stored and as sent: validated, clipped, with unusable questions dropped and the reason
 * reported. Throws nothing — the caller decides what an empty result means.
 *
 * Each question is `{ key, label, type: "noul" | "choice", instructions, criteria, pass }`, where `pass` is
 * the answer that means "fits": `true`/`false` for a noul, a list of option keys for a choice.
 */
export function normalizeQuestionSet(input) {
  const raw = Array.isArray(input?.questions) ? input.questions : [];
  const problems = [];
  const questions = [];
  const keys = new Set();
  for (const [idx, q] of raw.entries()) {
    const label = clip(q?.label, 80) || `Question ${idx + 1}`;
    const type = q?.type === "choice" ? "choice" : q?.type === "noul" || q?.type === "boolean" ? "noul" : "";
    const instructions = clip(q?.instructions, 1_200);
    if (!type) { problems.push(`${label}: unknown type`); continue; }
    if (!instructions) { problems.push(`${label}: no question written`); continue; }
    let key = slugKey(q?.key || label) || `q${idx + 1}`;
    while (keys.has(key)) key = `${key}_${idx + 1}`;
    if (type === "noul") {
      const t = clip(q?.criteria?.true, 400);
      const f = clip(q?.criteria?.false, 400);
      const criteria = t || f ? { ...(t ? { true: t } : {}), ...(f ? { false: f } : {}) } : undefined;
      const pass = q?.pass === false || q?.pass === "false" || q?.pass === "no" ? false : true;
      questions.push({ key, label, type, instructions, ...(criteria ? { criteria } : {}), pass });
    } else {
      const entries = Object.entries(q?.criteria && typeof q.criteria === "object" ? q.criteria : {})
        .map(([k, v]) => [slugKey(k), clip(v, 400)])
        .filter(([k]) => k)
        .slice(0, MAX_CHOICE_OPTIONS);
      if (entries.length < 2) { problems.push(`${label}: a choice needs at least two options`); continue; }
      const criteria = Object.fromEntries(entries);
      const pass = (Array.isArray(q?.pass) ? q.pass : [q?.pass]).map(slugKey).filter((k) => k in criteria);
      if (!pass.length) { problems.push(`${label}: no option is marked as a fit`); continue; }
      if (pass.length === entries.length) { problems.push(`${label}: every option is marked as a fit, so it can never fail anyone`); continue; }
      questions.push({ key, label, type, instructions, criteria, pass });
    }
    keys.add(key);
    if (questions.length >= MAX_QUESTIONS) break;
  }
  const keep = Number(input?.thresholds?.keep);
  const drop = Number(input?.thresholds?.drop);
  const thresholds = {
    keep: Number.isFinite(keep) && keep > 0 && keep < 1 ? keep : DEFAULT_THRESHOLDS.keep,
    drop: Number.isFinite(drop) && drop > 0 && drop < 1 ? drop : DEFAULT_THRESHOLDS.drop,
  };
  if (thresholds.drop >= thresholds.keep) { thresholds.keep = DEFAULT_THRESHOLDS.keep; thresholds.drop = DEFAULT_THRESHOLDS.drop; problems.push("Thresholds reset: the drop line must sit below the keep line"); }
  return { questions, thresholds, problems };
}

/** The question map in TypeSafe's wire format. `label` and `pass` are ours and never leave the server. */
export function toWireQuestions(questions) {
  const out = {};
  for (const q of questions) {
    out[q.key] = q.type === "noul"
      ? { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }
      : { type: "choice", instructions: q.instructions, criteria: q.criteria };
  }
  return out;
}

/* ═══ Verdicts ═══ */

/**
 * The probability that a question's answer is the "fits" one, or null if Jev did not answer it.
 * A noul whose fit answer is "no" is inverted; a choice sums the probabilities of every fit option.
 */
export function passProbability(question, answer) {
  if (!answer || typeof answer !== "object") return null;
  if (question.type === "noul") {
    const p = Number(answer.noul ?? answer.probability);
    if (!Number.isFinite(p)) return null;
    return question.pass ? p : 1 - p;
  }
  const probs = answer.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : null;
  if (probs) {
    let sum = 0;
    for (const k of question.pass) sum += Number(probs[k]) || 0;
    return Math.max(0, Math.min(1, sum));
  }
  if (typeof answer.choice === "string") return question.pass.includes(answer.choice) ? 1 : 0;
  return null;
}

/**
 * Combine one row's answers into `{ verdict: "good" | "borderline" | "bad", reason, scores }`.
 *
 * `reason` names the weakest question, which is what an engineer needs to judge a drop at a glance. A
 * question Jev did not answer makes the row borderline rather than silently passing it.
 */
export function verdictFor(questions, answers, thresholds = DEFAULT_THRESHOLDS) {
  const scores = {};
  let weakest = null;
  let missing = null;
  for (const q of questions) {
    const p = passProbability(q, answers?.[q.key]);
    scores[q.key] = p;
    if (p === null) { missing ??= q; continue; }
    if (!weakest || p < weakest.p) weakest = { q, p };
  }
  if (weakest && weakest.p < thresholds.drop) return { verdict: "bad", reason: `Failed: ${weakest.q.label}`, scores };
  if (missing) return { verdict: "borderline", reason: `No answer: ${missing.label}`, scores };
  if (!weakest) return { verdict: "borderline", reason: "No questions answered", scores };
  if (weakest.p < thresholds.keep) return { verdict: "borderline", reason: `Unsure: ${weakest.q.label}`, scores };
  return { verdict: "good", reason: "", scores };
}

/* ═══ Generation ═══ */

/**
 * Pull a question set out of a model's reply. Models fence JSON perhaps one run in ten, and a fenced object is
 * not a malformed one.
 */
export function parseGeneratedQuestionSet(text) {
  const body = String(text ?? "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return normalizeQuestionSet({});
  try { return normalizeQuestionSet(JSON.parse(body.slice(start, end + 1))); } catch { return normalizeQuestionSet({}); }
}
