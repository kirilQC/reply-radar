// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The pure half of the Jev list checker: CSV in, one compact profile per contact, a validated question set,
 * and the verdict that combines Jev's answers. No I/O, so `tests/jev.test.mjs` drives all of it.
 *
 * ── Why the profile is trimmed rather than the whole row ─────────────────────────────────────────
 * Exports differ wildly — see the Profiles section for how any header set is read. An AI Ark export, the richest
 * we get, carries ~280 columns and ~1,500 tokens a row: fifteen past jobs, education, publications,
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
/** Contact rows. A 20k-row, 250-column AI Ark export is a real list (Vitalic), and rows are kept as cell arrays. */
export const MAX_ROWS = 30_000;
/** Company rows are a tenth the size of a contact row, and company lists are the ones pulled by the hundred thousand. */
export const MAX_COMPANY_ROWS = 100_000;
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

/**
 * ── Why columns are classified rather than matched by name ───────────────────────────────────────
 * Lists come from AI Ark, Clay, Sales Navigator, Apollo and hand-made sheets, and no two agree on a header:
 * "Title", "Job Title", "Current Title", "position"; "Organization", "Company Name", "Account"; "1st Experience
 * Company", "Experience 2 Company", "job_3_company". So every header is read for what it *means* — its words
 * and, when those are not enough, a sample of its values — and mapped onto one fixed profile shape.
 *
 * ── Why the profile shape is fixed ───────────────────────────────────────────────────────────────
 * A client's questions name profile fields in backticks (`current_roles`, `listed_company_profile.description`).
 * If the fields were whatever the file called them, a question set drafted against an AI Ark export would point
 * at nothing on the next Sales Nav export and Jev would answer against an empty field. With one shape, a question
 * set works on any file; a file that simply lacks a field is reported, not silently mis-scored.
 */

/** Every role a column can be assigned, in the order the column panel lists them. */
export const COLUMN_ROLES = {
  title: "Job title",
  headline: "Headline",
  about: "About / summary",
  seniority: "Seniority",
  department: "Department / function",
  location: "Person location",
  skills: "Skills",
  company: "Company name",
  company_industry: "Company industry",
  company_employees: "Company size",
  company_description: "Company description",
  company_products: "Company products / keywords",
  company_funding: "Company funding stage",
  company_revenue: "Company revenue",
  company_location: "Company location",
  company_type: "Company type",
  company_locations: "Company number of locations",
  experience: "Job history (numbered)",
  experience_json: "Job history (JSON list)",
  other: "Send as extra",
  name: "Full name (not sent)",
  first_name: "First name (not sent)",
  last_name: "Last name (not sent)",
  linkedin: "LinkedIn URL (not sent)",
  website: "Company website (not sent)",
  company_linkedin: "Company LinkedIn (not sent)",
  ignore: "Ignore",
};
/** Roles that identify the row rather than describe it. Used for display and de-duplication only, never sent. */
const IDENTITY_ROLES = new Set(["name", "first_name", "last_name", "linkedin", "website", "company_linkedin"]);

const MAX_CURRENT_ROLES = 4;
const MAX_PAST_ROLES = 8;
const ROLE_ABOUT = 1_200;
const MAX_OTHER_COLUMNS = 8;
const OTHER_BUDGET = 1_500;
/*
 * Per-field caps on what Jev is sent. Sized so a real AI Ark row reaches Jev whole: an About section runs to
 * ~2,300 characters and a single job description past 1,000, and the earlier caps (600 and 240) cut a Medicare
 * Advantage mention two-thirds of the way through someone's About clean out of the profile.
 */
const CLIP = { title: 160, headline: 300, about: 3_000, seniority: 40, department: 80, location: 100, skills: 600, company: 120, company_industry: 100, company_employees: 30, company_description: 500, company_products: 250, company_funding: 40, company_revenue: 40, company_location: 100, company_type: 40, company_locations: 20, other: 300 };
/** A company list has nothing else to go on, so its descriptive fields get more room than a contact's do. */
const COMPANY_CLIP = { ...CLIP, company_description: 900, company_products: 400, company_industry: 160 };

/** A header as lowercase words: "1st Experience Company" → "1st experience company". */
// camelCase is split ("jobTitle" → "job title"), but brand casing is protected first, or "LinkedIn" becomes
// "linked in" and the LinkedIn column — the de-duplication key — is silently ignored.
const words = (h) => ` ${String(h).replace(/linked\s*in/gi, "linkedin").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim()} `;
const has = (w, re) => re.test(w);

/** Header words that mean a column can never help decide fit. Checked before anything else. */
const NOISE_WORDS = /\s(url|urls|website|domain|domains|email|emails|e mail|phone|phones|mobile|fax|tel|id|ids|uuid|guid|picture|photo|avatar|image|logo|twitter|facebook|instagram|github|youtube|tiktok|mx|bounce|bounceban|verified|verification|provider|catch|settings|updated|created|modified|timestamp|birth|birthday|dob|followers|connections|zip|postal|postcode|address|street|latitude|longitude|lat|lng|owner|education|school|degree|grade|university|publication|publications|patent|patents|certification|certifications|volunteer|language|languages|growth|count|founded|founding|amount|date|dates|number|rank|score|status|source|list|campaign|sequence|stage id)\s/;
/** Numbered job-history columns: "1st Experience Title", "Experience 2 Company", "job_3_title", "Position 1 - Company". */
const EXPERIENCE_RE = /\s(?:(\d+)(?:st|nd|rd|th)?\s+)?(?:past\s+|previous\s+|prior\s+)?(experience|experiences|job|jobs|position|positions|employment|work|role|roles)\s+(?:(\d+)(?:st|nd|rd|th)?\s+)?(.+?)\s$/;

/** What one numbered-experience column holds. */
function experienceField(rest) {
  const w = ` ${rest} `;
  if (has(w, /\s(id|url|linkedin|domain|website|logo)\s/)) return "";
  if (has(w, /\scurrent\s/)) return "current";
  if (has(w, /\s(title|position|role|job title)\s/)) return "title";
  if (has(w, /\s(company|organization|organisation|employer|org)\s/)) return "company";
  if (has(w, /\s(summary|description|about)\s/)) return "about";
  if (has(w, /\s(start|from|began)\s/)) return "start";
  if (has(w, /\s(end|to|until)\s/)) return "end";
  return "";
}

/** The role a header implies on its words alone, or "" when the words do not say. */
function roleFromHeader(header) {
  const w = words(header);
  if (has(w, /\sbottom\s/)) return { role: "ignore", why: "oldest job" };
  const exp = w.match(EXPERIENCE_RE);
  if (exp && (exp[1] || exp[3])) {
    const field = experienceField(exp[4]);
    return field ? { role: "experience", index: Number(exp[1] || exp[3]), field } : { role: "ignore", why: "job-history detail" };
  }
  // Company-scoped columns first, so "Company Description" is not read as the person's description. The
  // specific fields are matched before the noise words because some carry one: "Company Employee Count".
  const companyScoped = has(w, /^\s(company|organization|organisation|account|employer|business|firm)\s/) || has(w, /\scompany\s/);
  if (companyScoped) {
    if (has(w, /\s(growth|change|increase)\s/)) return { role: "ignore", why: "not about fit" };
    if (has(w, /\slinkedin\s/) && !has(w, /\s(followers|id)\s/)) return { role: "company_linkedin" };
    if (has(w, /\s(website|domain|url)\s/) && !has(w, /\s(logo|image|linkedin)\s/)) return { role: "website" };
    if (has(w, /\s(locations|sites|facilities|offices)\s/) && !has(w, /\saddress\s/)) return { role: "company_locations" };
    if (has(w, /\s(industry|industries|sector|vertical)\s/)) return { role: "company_industry" };
    if (has(w, /\s(employees|employee|headcount|size|staff)\s/)) return { role: "company_employees" };
    if (has(w, /\s(description|about|overview|summary|tagline|bio)\s/)) return { role: "company_description" };
    if (has(w, /\s(products?|services?|specialt(y|ies)|keywords?|technolog(y|ies)|categor(y|ies)|tags|offerings?)\s/)) return { role: "company_products" };
    if (has(w, /\s(funding|round|series)\s/) && !has(w, /\s(amount|date|total|raised|investors?)\s/)) return { role: "company_funding" };
    if (has(w, /\srevenue\s/)) return { role: "company_revenue" };
    if (has(w, /\s(country|hq|headquarters?|location|city|state|region)\s/)) return { role: "company_location" };
    if (has(w, /\stype\s/)) return { role: "company_type" };
    if (NOISE_WORDS.test(w)) return { role: "ignore", why: "not about fit" };
    if (has(w, /^\s(company|organization|organisation|account|employer|business|firm)( name)?\s$/) || has(w, /^\s(current )?company name\s$/)) return { role: "company" };
    return { role: "", why: "company detail" };
  }
  if (has(w, /^\s(full name|name|contact name|person name|lead name|contact)\s$/)) return { role: "name" };
  if (has(w, /^\s(first name|firstname|given name|first)\s$/)) return { role: "first_name" };
  if (has(w, /^\s(last name|lastname|surname|family name|last)\s$/)) return { role: "last_name" };
  if (has(w, /\slinkedin\s/) && !has(w, /\sfollowers\s/) && has(w, /\s(url|profile|linkedin)\s$/)) return { role: "linkedin" };
  if (has(w, /^\s(profile url|li url|sales nav(igator)? url)\s$/)) return { role: "linkedin" };
  if (has(w, /^\s(current )?(job )?(title|position|job title|role|designation|occupation)\s$/)) return { role: "title" };
  if (has(w, /^\s(current )?(organization|organisation|org|employer|account name|account|company|firm|workplace)\s$/)) return { role: "company" };
  if (has(w, /^\s(website|domain|domain url|company url|web|homepage)\s$/)) return { role: "website" };
  if (has(w, /\s(industry|industries|sector|vertical)\s/) && !has(w, /\s(growth|id)\s/)) return { role: "company_industry" };
  if (has(w, /^\s(# employees|employees|employee count|employee size|headcount|num employees|number of employees|size|employee range|employees range|staff count)\s$/)) return { role: "company_employees" };
  if (has(w, /^\s(description|short description|seo description|overview|about us)\s$/)) return { role: "company_description" };
  if (has(w, /\s(keywords|technologies|specialties|specialities|products?|services?|offerings?)\s/)) return { role: "company_products" };
  if (has(w, /\s(locations|sites|facilities)\s/) && !has(w, /\saddress\s/)) return { role: "company_locations" };
  if (has(w, /\s(funding stage|latest funding|last funding type|funding type|funding)\s/) && !has(w, /\s(amount|date|total|raised)\s/)) return { role: "company_funding" };
  if (has(w, /\s(annual revenue|revenue|revenue range)\s/)) return { role: "company_revenue" };
  if (NOISE_WORDS.test(w)) return { role: "ignore", why: "not about fit" };
  if (has(w, /\s(headline|tagline)\s/)) return { role: "headline" };
  if (has(w, /\s(summary|about|bio|biography)\s/) || has(w, /^\s(profile|person|linkedin) description\s$/)) return { role: "about" };
  if (has(w, /\s(seniority|management level|level)\s/)) return { role: "seniority" };
  if (has(w, /\s(department|departments|function|functions|job function)\s/)) return { role: "department" };
  if (has(w, /^\s(location|city|state|country|region|geo|geography|metro|person location|person country|person city|person state)\s$/)) return { role: "location" };
  if (has(w, /\sskills?\s/)) return { role: "skills" };
  if (has(w, /^\s(experience|experiences|work history|employment history|positions|jobs)\s$/)) return { role: "", why: "job history" };
  return { role: "" };
}

const VALUE_NOISE = [
  /^https?:\/\//i, /^www\./i, /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i, /^\+?[\d\s().-]{7,}$/, /^[0-9a-f]{8}-[0-9a-f]{4}-/i,
  /^-?[\d,.]+%?$/, /^\d{4}-\d{2}-\d{2}([ T].*)?$/, /^\d{1,2}\/\d{1,2}\/\d{2,4}$/, /^[a-z0-9.-]+\.(com|io|ai|co|net|org|dev|app)(\/.*)?$/i,
];

/**
 * Read a column's values when its header does not say what it is. Decides between "job history as JSON",
 * "send as extra", and "ignore" — URLs, emails, phone numbers, ids, bare numbers and dates are ignored, as is a
 * column holding one value on every row, which cannot tell one contact from another.
 */
function roleFromValues(values) {
  const sample = values.filter((v) => v && v.trim()).slice(0, 40);
  if (!sample.length) return { role: "ignore", why: "empty" };
  // An empty list ("[]") is a person with no history, not evidence against the column being job history.
  const lists = sample.filter((v) => /^\s*\[/.test(v));
  if (lists.length >= sample.length * 0.6 && lists.some((v) => /^\s*\[\s*\{/.test(v))) return { role: "experience_json" };
  const noisy = sample.filter((v) => VALUE_NOISE.some((re) => re.test(v.trim()))).length;
  if (noisy >= sample.length * 0.8) return { role: "ignore", why: "links, ids or numbers" };
  if (sample.length >= 5 && new Set(sample.map((v) => v.trim().toLowerCase())).size === 1) return { role: "ignore", why: "same on every row" };
  const avg = sample.reduce((n, v) => n + v.length, 0) / sample.length;
  if (avg < 2) return { role: "ignore", why: "too short to mean anything" };
  return { role: "other" };
}

/**
 * The column plan for a file: one entry per header saying what it is. Computed once from the headers and a
 * sample of rows (cell arrays), then applied to every row. `overrides` (header → role) wins over detection, so
 * an engineer can correct a column the rules misread.
 */
export function planColumns(headers, sampleRows = [], overrides = {}) {
  const columns = headers.map((header, idx) => {
    const values = sampleRows.map((cells) => (Array.isArray(cells) ? cells[idx] : cells?.[header]) ?? "");
    const forced = overrides[header];
    if (forced && forced in COLUMN_ROLES) {
      const exp = forced === "experience" ? roleFromHeader(header) : null;
      return { header, idx, role: forced, ...(exp?.role === "experience" ? { index: exp.index, field: exp.field } : {}), overridden: true, filled: values.filter((v) => v && v.trim()).length };
    }
    let found = roleFromHeader(header);
    if (!found.role) found = roleFromValues(values);
    return { header, idx, ...found, filled: values.filter((v) => v && v.trim()).length };
  });
  // An "extra" column only earns its place if it has content; cap how many are sent so a 300-column export
  // cannot turn every unrecognised field into state.
  let extras = 0;
  for (const c of columns) {
    if (c.role !== "other" || c.overridden) continue;
    if (!c.filled || extras >= MAX_OTHER_COLUMNS) { c.role = "ignore"; c.why = c.filled ? "extra-column limit" : "empty"; continue; }
    extras += 1;
  }
  const experienceHasCurrent = columns.some((c) => c.role === "experience" && c.field === "current");
  const experienceHasEnd = columns.some((c) => c.role === "experience" && c.field === "end");
  return { columns, experienceHasCurrent, experienceHasEnd };
}

const clipTo = (role, value) => clip(value, CLIP[role] ?? 300);
const truthy = (v) => /^(true|yes|y|1|current|present)$/i.test(String(v ?? "").trim());
const cell = (cells, c) => (Array.isArray(cells) ? cells[c.idx] : cells?.[c.header]) ?? "";

/** Current roles from a JSON job-history cell, tolerating the key spellings Clay and scrapers use. */
function rolesFromJson(text) {
  let list;
  try { list = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const pick = (o, keys) => { for (const k of keys) if (o?.[k] != null && String(o[k]).trim()) return String(o[k]); return ""; };
  const jobs = list.filter((o) => o && typeof o === "object").map((o) => ({
    title: clip(pick(o, ["title", "position", "job_title", "jobTitle", "role"]), 140),
    company: clip(pick(o, ["company", "company_name", "companyName", "organization", "org", "employer"]), 120),
    since: clip(pick(o, ["start", "start_date", "startDate", "starts_at", "from"]), 10),
    end: pick(o, ["end", "end_date", "endDate", "ends_at", "to"]),
    current: o.is_current ?? o.isCurrent ?? o.current,
    about: clip(pick(o, ["description", "summary", "about"]), ROLE_ABOUT),
  })).filter((j) => j.title || j.company);
  const flagged = jobs.some((j) => j.current !== undefined);
  const current = jobs.filter((j) => (flagged ? truthy(j.current) || j.current === true : !j.end || truthy(j.end)));
  return (current.length ? current : jobs.slice(0, 1)).slice(0, MAX_CURRENT_ROLES).map(({ title, company, since, about }) => prune({ title, company, since, about }) ?? {});
}

/**
 * The jobs a person holds now, from numbered history columns. "Current" is read from an explicit flag when the
 * file has one, from a blank end date when it has those, and otherwise the first job listed is taken as current
 * — the order every export we have seen uses.
 */
/** Numbered job-history columns grouped by position, in the order the export lists them (most recent first). */
function historyGroups(cells, plan) {
  const groups = new Map();
  for (const c of plan.columns) {
    if (c.role !== "experience" || !c.field) continue;
    const g = groups.get(c.index) ?? {};
    const v = cell(cells, c);
    if (v && !g[c.field]) g[c.field] = v;
    groups.set(c.index, g);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g).filter((g) => g.title || g.company);
}

/**
 * The most recent jobs a person has LEFT, with what they did there. A generic current title ("Director") says
 * little, and the connection a client cares about is often in the jobs before it — eight years at a Medicare
 * Advantage plan, a risk-adjustment role two jobs ago. Capped at four, most recent first.
 */
function pastRoles(cells, plan) {
  const ordered = historyGroups(cells, plan);
  let past;
  if (plan.experienceHasCurrent) past = ordered.filter((g) => !truthy(g.current));
  else if (plan.experienceHasEnd) past = ordered.filter((g) => String(g.end ?? "").trim() && !truthy(g.end));
  else past = ordered.slice(1);
  return past.slice(0, MAX_PAST_ROLES).map((g) => prune({ title: clip(g.title, 140), company: clip(g.company, 120), from: clip(g.start, 10), to: clip(g.end, 10), about: clip(g.about, ROLE_ABOUT) }) ?? {});
}

function currentRoles(cells, plan) {
  const groups = new Map();
  for (const c of plan.columns) {
    if (c.role !== "experience" || !c.field) continue;
    const g = groups.get(c.index) ?? {};
    const v = cell(cells, c);
    if (v && !g[c.field]) g[c.field] = v;
    groups.set(c.index, g);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, g]) => g).filter((g) => g.title || g.company);
  let current;
  if (plan.experienceHasCurrent) current = ordered.filter((g) => truthy(g.current));
  else if (plan.experienceHasEnd) current = ordered.filter((g) => !String(g.end ?? "").trim() || truthy(g.end));
  else current = ordered.slice(0, 1);
  const roles = current.slice(0, MAX_CURRENT_ROLES).map((g) => prune({ title: clip(g.title, 140), company: clip(g.company, 120), since: clip(g.start, 10), about: clip(g.about, ROLE_ABOUT) }) ?? {});
  for (const c of plan.columns) if (c.role === "experience_json" && !roles.length) roles.push(...rolesFromJson(cell(cells, c)));
  return roles;
}

/** Roles whose columns are joined rather than first-wins: two descriptions or two industry lists each add something. */
const JOINED = new Set(["location", "company_location", "company_industry", "company_description", "company_products"]);

/** Values for one role across every column assigned to it: the first for single facts, a de-duplicated join for the rest. */
function valueFor(cells, plan, role, clips = CLIP) {
  const vals = plan.columns.filter((c) => c.role === role).map((c) => String(cell(cells, c)).trim()).filter(Boolean);
  if (!vals.length) return "";
  const max = clips[role] ?? 300;
  if (JOINED.has(role)) {
    const out = [];
    for (const v of vals) if (!out.some((o) => o.toLowerCase().includes(v.toLowerCase()))) out.push(v);
    return clip(out.join(role.endsWith("location") ? ", " : " · "), max);
  }
  return clip(vals[0], max);
}

/**
 * The profile Jev sees for one row, always in the same shape whatever the file looked like. Fields a file does
 * not have are simply absent. Identity (names, LinkedIn URL) is never included.
 */
export function buildProfile(cells, plan) {
  const roles = currentRoles(cells, plan);
  const other = {};
  let spent = 0;
  for (const c of plan.columns) {
    if (c.role !== "other") continue;
    const v = clipTo("other", cell(cells, c));
    if (!v || spent + v.length > OTHER_BUDGET) continue;
    other[c.header] = v;
    spent += v.length;
  }
  const profile = {
    listed_title: valueFor(cells, plan, "title") || roles[0]?.title || "",
    listed_company: valueFor(cells, plan, "company") || roles[0]?.company || "",
    headline: valueFor(cells, plan, "headline"),
    about: valueFor(cells, plan, "about"),
    seniority: valueFor(cells, plan, "seniority"),
    department: valueFor(cells, plan, "department"),
    location: valueFor(cells, plan, "location"),
    skills: valueFor(cells, plan, "skills"),
    current_roles: roles,
    past_roles: pastRoles(cells, plan),
    listed_company_profile: {
      industry: valueFor(cells, plan, "company_industry"),
      employees: valueFor(cells, plan, "company_employees"),
      description: valueFor(cells, plan, "company_description"),
      products: valueFor(cells, plan, "company_products"),
      funding: valueFor(cells, plan, "company_funding"),
      revenue: valueFor(cells, plan, "company_revenue"),
      location: valueFor(cells, plan, "company_location"),
      type: valueFor(cells, plan, "company_type"),
    },
    other,
  };
  return prune(profile) ?? {};
}

/** Who a row is, for the table and de-duplication — never sent to Jev. */
export function identifyWith(cells, plan) {
  const first = valueFor(cells, plan, "first_name");
  const last = valueFor(cells, plan, "last_name");
  const name = clip(plan.columns.filter((c) => c.role === "name").map((c) => cell(cells, c)).find((v) => String(v).trim()) || `${first} ${last}`, 120);
  const roles = currentRoles(cells, plan);
  return {
    name: name || "(no name)",
    title: valueFor(cells, plan, "title") || roles[0]?.title || "",
    company: valueFor(cells, plan, "company") || roles[0]?.company || "",
    linkedin: clip(plan.columns.filter((c) => c.role === "linkedin").map((c) => cell(cells, c)).find((v) => String(v).trim()) ?? "", 300),
  };
}

/**
 * The profile Jev sees for one row of a *company* list. The company name is included — it is not personal data,
 * and "Children's Hospital of …" or "… Hospice" is often the strongest signal a company list carries.
 */
export function buildCompanyProfile(cells, plan) {
  const other = {};
  let spent = 0;
  for (const c of plan.columns) {
    if (c.role !== "other") continue;
    const v = clipTo("other", cell(cells, c));
    if (!v || spent + v.length > OTHER_BUDGET) continue;
    other[c.header] = v;
    spent += v.length;
  }
  const v = (role) => valueFor(cells, plan, role, COMPANY_CLIP);
  return prune({
    name: v("company"),
    industry: v("company_industry"),
    description: v("company_description"),
    products: v("company_products"),
    employees: v("company_employees"),
    locations: v("company_locations"),
    type: v("company_type"),
    funding: v("company_funding"),
    revenue: v("company_revenue"),
    location: v("company_location") || v("location"),
    other,
  }) ?? {};
}

/** A company row's identity for the table and de-duplication (website, then LinkedIn page, then name). */
export function identifyCompany(cells, plan) {
  const first = (role) => plan.columns.filter((c) => c.role === role).map((c) => String(cell(cells, c)).trim()).find(Boolean) ?? "";
  const name = clip(first("company"), 120);
  const website = clip(first("website"), 200);
  // In a company list a bare "LinkedIn" column is the company's own page, not a person's.
  const linkedin = clip(first("company_linkedin") || first("linkedin"), 300);
  const domain = website.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
  // The website is the de-duplication key before the LinkedIn page: exports fill it far more often, and two rows
  // for one company routinely differ in whether the LinkedIn column was populated.
  return { name: name || "(no name)", title: clip(valueFor(cells, plan, "company_industry"), 80), company: domain, linkedin: domain ? `https://${domain}` : linkedin };
}

/** Convenience for one row as an object: plan from its own headers, then build. */
export function profileFor(row, headers) { return buildProfile(row, planColumns(headers, [row])); }
export function identify(row, headers) { return identifyWith(row, planColumns(headers, [row])); }

/** How the plan reads a file, for the column panel: used vs not sent vs ignored. */
export function planSummary(plan) {
  const used = plan.columns.filter((c) => c.role !== "ignore" && !IDENTITY_ROLES.has(c.role));
  const identity = plan.columns.filter((c) => IDENTITY_ROLES.has(c.role));
  const ignored = plan.columns.filter((c) => c.role === "ignore");
  return { used: used.length, identity: identity.length, ignored: ignored.length };
}

/** The top-level profile fields a question refers to in backticks: `listed_company_profile.description` → that path. */
export function questionFieldRefs(question) {
  const text = [question?.instructions, ...Object.values(question?.criteria ?? {})].map((v) => (typeof v === "string" ? v : JSON.stringify(v ?? ""))).join(" ");
  return [...new Set([...text.matchAll(/`([a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)*)(?:\[\d+\])?`/gi)].map((m) => m[1]))];
}

/**
 * For each question, the profile fields it names that most of this file's contacts do not have. A question
 * about `current_roles` on a file with no job history will be answered against nothing, and the engineer should
 * know that before paying for the run.
 */
/** The profile's own top-level fields. Anything else a question names in backticks is a field inside a role. */
const PROFILE_FIELDS = new Set(["listed_title", "listed_company", "headline", "about", "seniority", "department", "location", "skills", "current_roles", "past_roles", "listed_company_profile", "other"]);

/**
 * For each question, the profile fields it names when most of this file's contacts have NONE of them — the case
 * where Jev really is answering blind.
 *
 * ── Why "none of them", and why only top-level fields ───────────────────────────────────────────
 * The first version flagged a question if any one field it named was missing, and read every backticked word as a
 * field. On a Vitalic AI Ark export that warned "no `to`" (the end date inside a past role) and "no `about`" (meant
 * as a role's description) under questions that also read the headline, current roles and past roles — a false
 * alarm on every question. A question is blind only when it has nothing at all to go on.
 */
export function missingFields(questions, profiles) {
  const n = Math.min(profiles.length, 200);
  const sample = profiles.slice(0, n);
  const present = (p, path) => { const v = path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), p); return v !== undefined && !(Array.isArray(v) && !v.length); };
  const out = {};
  if (!n) return out;
  for (const q of questions) {
    const refs = questionFieldRefs(q).filter((path) => PROFILE_FIELDS.has(path.split(".")[0]));
    if (!refs.length) continue;
    const blind = sample.filter((p) => !refs.some((path) => present(p, path))).length;
    if (blind >= n * 0.5) out[q.key] = refs;
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
      questions.push({ key, label, type, instructions, ...(criteria ? { criteria } : {}), pass, kind: kindOf(q, pass) });
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
      // "Can't tell" options: named explicitly, or recognised by their key. Never also a fit.
      const named = Array.isArray(q?.neutral) ? q.neutral.map(slugKey) : [];
      const neutral = Object.keys(criteria).filter((k) => !pass.includes(k) && (named.includes(k) || (!Array.isArray(q?.neutral) && NEUTRAL_KEY.test(k))));
      questions.push({ key, label, type, instructions, criteria, pass, ...(neutral.length ? { neutral } : {}), kind: kindOf(q, true) });
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
  const icp = normalizeIcp(input?.icp);
  const scoring = SCORING_MODES.includes(input?.scoring) ? input.scoring : "gates";
  const keepTerms = normalizeKeepTerms(input?.keepTerms);
  return { questions, thresholds, problems, scoring, ...(keepTerms.length ? { keepTerms } : {}), ...(icp ? { icp } : {}) };
}

/**
 * What a question does to the verdict.
 * - `must`: the contact has to pass it; a clear fail drops them.
 * - `exclude`: a disqualifier (competitor, wrong specialty); drops the contact only when it is clearly true.
 * - `signal`: evidence for or against; only moves the fit score.
 * Sets saved before kinds existed get `exclude` for a noul whose fit answer is "no" — those were always written
 * as disqualifiers — and `must` for everything else.
 */
export const QUESTION_KINDS = ["must", "exclude", "signal"];
/**
 * How the answers become a verdict.
 * - `gates`: must-haves and exclusions can drop a contact on their own; signals rank.
 * - `weighted`: every question counts the same and none can drop anyone alone — the average decides, and the
 *   middle band is "maybe", kept for a thinking model or a person to look at. Asked for on a 20k-contact Vitalic
 *   list where a generic title failing one question must not throw the contact away. The single exception is a
 *   question explicitly marked `must` (e.g. "current title is director or above"), which still drops on a clear fail.
 */
export const SCORING_MODES = ["gates", "weighted"];
const kindOf = (q, pass) => (QUESTION_KINDS.includes(q?.kind) ? q.kind : pass === false ? "exclude" : "must");
const NEUTRAL_KEY = /^(unclear|unknown|not_stated|not_sure|cannot_tell|can_t_tell|no_data|insufficient|none_stated|not_enough_info)$/;

/**
 * The structured half of a client's contact ICP: the pool of target titles, what those people are responsible
 * for, the company size range, and exclusions. Titles and size are applied in code and by a question built from
 * the pool verbatim; the rest feeds the question writer.
 */
export function normalizeIcp(raw) {
  if (!raw || typeof raw !== "object") return null;
  const lines = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/\r?\n|;/)).map((x) => clip(String(x).replace(/^[\s•*-]+/, ""), 80)).filter(Boolean);
  const num = (v) => { const n = Number(String(v ?? "").replace(/[^0-9]/g, "")); return String(v ?? "").trim() && Number.isFinite(n) && n > 0 ? n : null; };
  const titles = [...new Set(lines(raw.titles))].slice(0, 200);
  const icp = {
    titles,
    responsibilities: clip(raw.responsibilities, 1_000),
    sizeMin: num(raw.sizeMin),
    sizeMax: num(raw.sizeMax),
    exclusions: clip(raw.exclusions, 1_000),
  };
  if (icp.sizeMin && icp.sizeMax && icp.sizeMin > icp.sizeMax) [icp.sizeMin, icp.sizeMax] = [icp.sizeMax, icp.sizeMin];
  return icp.titles.length || icp.responsibilities || icp.sizeMin || icp.sizeMax || icp.exclusions ? icp : null;
}

/**
 * The title-pool question, built from the pool verbatim — never paraphrased by a model, because the pool is the
 * team's own definition of who they sell to. Jev picks which target role the person's current job matches, with
 * room for a similar role the pool did not spell out, and a neutral "can't tell".
 */
export function titlePoolQuestion(icp, descriptions = {}) {
  if (!icp?.titles?.length) return null;
  const criteria = {};
  for (const t of icp.titles) {
    const k = slugKey(t);
    if (k && !criteria[k]) criteria[k] = descriptions[k] ? `${t}: ${descriptions[k]}` : t;
  }
  const keys = Object.keys(criteria);
  criteria.similar_role = "A different title that carries the same responsibilities as one of the target roles above";
  criteria.not_a_target = "None of the target roles — a different function, or too junior to be one of them";
  criteria.unclear = "The profile does not say enough about their current job to tell";
  return {
    key: "target_role", label: "Target role", type: "choice", kind: "must",
    instructions: "Which of these target roles best matches this person's CURRENT main job? Judge by what they are responsible for, using `listed_title`, `headline`, `about` and `current_roles` — not by exact title wording.",
    criteria, pass: [...keys, "similar_role"], neutral: ["unclear"],
  };
}

/** Employee count as a range, from the forms exports use: "11-50", "3482", "10001+", "1,001-5,000 employees". */
export function parseEmployees(value) {
  const s = String(value ?? "").replace(/,/g, "");
  const nums = (s.match(/\d+/g) ?? []).map(Number);
  if (!nums.length) return null;
  if (/\+/.test(s) || /more than|over/i.test(s)) return { min: nums[0], max: Infinity };
  return nums.length >= 2 ? { min: Math.min(nums[0], nums[1]), max: Math.max(nums[0], nums[1]) } : { min: nums[0], max: nums[0] };
}

/** The company-size check, in code: "outside", "inside", or null when the size is unknown or no range is set. */
export function sizeCheck(icp, profile) {
  if (!icp || (!icp.sizeMin && !icp.sizeMax)) return null;
  const size = parseEmployees(profile?.listed_company_profile?.employees ?? profile?.employees);
  if (!size) return null;
  const lo = icp.sizeMin ?? 0, hi = icp.sizeMax ?? Infinity;
  return size.max < lo || size.min > hi ? "outside" : "inside";
}

/** The question map in TypeSafe's wire format. `label`, `pass`, `kind` and `neutral` are ours and never leave the server. */
export function toWireQuestions(questions) {
  const out = {};
  for (const q of questions) {
    out[q.key] = q.type === "noul"
      ? { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }
      : { type: "choice", instructions: q.instructions, criteria: q.criteria };
  }
  return out;
}

/* ═══ Company tagging ═══ */

/**
 * A tag set: the categories a company list is sorted into, each with a plain-language description.
 *
 * ── Why every tag carries a description ──────────────────────────────────────────────────────────
 * Neighbouring tags are the whole difficulty — Community Hospital vs Safety Net Hospital vs Critical Access
 * Hospital — and a bare label gives Jev nothing to separate them on. TypeSafe's guidance is that plain-language
 * option descriptions with the boundary cases written in are what make a Choice accurate.
 *
 * ── Why "Other" is always present ────────────────────────────────────────────────────────────────
 * A choice must pick something. Without an exit, a chess club in a "mental health care" export is forced into
 * the nearest healthcare tag with a confident-looking probability. So a set without one gets one added.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.6;

/**
 * An instruction that leaked into a tag's name — "tag each company as one of the following: Health System" — left
 * as just the tag. Happened when a typed description was split on "|" with its lead-in still attached to the first
 * tag; a set saved that way is repaired on load by this, and the key is re-derived so it reads cleanly.
 */
const INSTRUCTION_PREFIX = /^\s*(?:please\s+)?(?:tag|classify|categori[sz]e|label|sort|bucket|assign|group)\b[^:]{0,120}:\s*/i;
export const stripInstruction = (label) => String(label ?? "").replace(INSTRUCTION_PREFIX, "").trim();

export function normalizeTagSet(input) {
  const raw = Array.isArray(input?.tags) ? input.tags : [];
  const problems = [];
  const tags = [];
  const keys = new Set();
  for (const t of raw) {
    const rawLabel = typeof t === "string" ? t : t?.label;
    const label = clip(stripInstruction(rawLabel), 80);
    if (!label) continue;
    const repaired = label !== clip(rawLabel, 80);
    let key = slugKey(typeof t === "object" && t?.key && !repaired ? t.key : label) || `tag_${tags.length + 1}`;
    if (keys.has(key)) { problems.push(`"${label}" appears twice; kept the first`); continue; }
    keys.add(key);
    tags.push({ key, label, description: clip(typeof t === "object" ? t?.description : "", 500) });
    if (tags.length >= MAX_CHOICE_OPTIONS) { problems.push(`Only the first ${MAX_CHOICE_OPTIONS} tags are kept`); break; }
  }
  if (tags.length && !tags.some((t) => t.key === "other" || /^other\b|none of the above/i.test(t.label))) {
    tags.push({ key: "other", label: "Other", description: "None of the other categories fits, or the profile does not say enough to tell" });
    problems.push("Added an Other tag so nothing is forced into the wrong category");
  }
  if (tags.length < 2) problems.push("A tag set needs at least two tags");
  const min = Number(input?.minConfidence);
  return {
    instructions: clip(input?.instructions, 600) || "Which category best describes what this organization is?",
    tags: tags.length >= 2 ? tags : [],
    minConfidence: Number.isFinite(min) && min > 0 && min < 1 ? min : DEFAULT_MIN_CONFIDENCE,
    problems,
  };
}

/** Tags typed or pasted as "A | B | C", one per line, or comma-separated. */
/**
 * Tags typed or pasted as a list — "A | B | C", one per line, or comma-separated — each optionally followed by
 * its own description: "Health System: A multi-hospital organization that…" or "Health System — …".
 *
 * ── Why a name/description split, and why it is conservative ─────────────────────────────────────
 * One per line with a description after a colon is how people write a taxonomy, and reading the whole line as the
 * name produced 71 tags called "Health System: A multi-hospital organization that owns or operates two or more
 * h…" with no descriptions. A line is split at its first ": " or " — " only when what follows reads as a sentence
 * (three words or more), so a name that itself contains a colon, "Post-Acute: Skilled Nursing", stays whole.
 * A heading line like "Tag each company as one of the following:" is an instruction and is dropped.
 */
export function parseTagEntries(text) {
  const s = String(text ?? "").replace(/^[^|\n]*?:\s*(?=[^|\n]*\|)/, "");
  const parts = s.includes("|") ? s.split("|") : s.includes("\n") ? s.split(/\r?\n/) : s.split(",");
  const out = [];
  for (const raw of parts) {
    const part = raw.replace(/^[\s•*·-]+/, "").replace(/^\d{1,3}[.)]\s+/, "").trim();
    if (!part) continue;
    // A heading: ends in a colon with nothing after it, or is an instruction with nothing left once stripped.
    if (/:\s*$/.test(part) || !stripInstruction(part)) continue;
    const m = part.match(/^(.{2,80}?)\s*(?::|\s[—–]\s|\s-\s)\s*(.+)$/);
    if (m && m[2].trim().split(/\s+/).length >= 3) out.push({ label: stripInstruction(m[1]).trim(), description: m[2].trim() });
    else out.push({ label: stripInstruction(part), description: "" });
  }
  return out.filter((e) => e.label);
}

/** Just the names from a typed tag list. */
export function parseTagList(text) {
  return parseTagEntries(text).map((e) => e.label);
}

/** The one Choice question a company run asks. The label leads each option so the model never sees a bare slug. */
export function toTagWire(tagSet) {
  const criteria = {};
  for (const t of tagSet.tags) criteria[t.key] = t.description ? `${t.label}: ${t.description}` : t.label;
  return { category: { type: "choice", instructions: tagSet.instructions, criteria } };
}

/**
 * A company's tag from Jev's answer: the top option, its confidence, and the runner-up when it is a real
 * contender. Below the set's confidence line the company is "review" rather than silently tagged.
 */
export function tagVerdict(tagSet, answer) {
  const probs = answer?.probabilities && typeof answer.probabilities === "object" ? answer.probabilities : null;
  if (!probs) return { status: "error", reason: "Jev returned no category" };
  const ranked = Object.entries(probs).map(([k, p]) => [k, Number(p) || 0]).sort((a, b) => b[1] - a[1]);
  const label = (k) => tagSet.tags.find((t) => t.key === k)?.label ?? k;
  const [topKey, topP] = ranked[0] ?? [answer.choice, 0];
  const confidence = Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : topP;
  const second = ranked[1] && ranked[1][1] >= 0.15 ? { tag: ranked[1][0], label: label(ranked[1][0]), p: ranked[1][1] } : null;
  return {
    status: confidence >= tagSet.minConfidence ? "tagged" : "review",
    tag: topKey,
    label: label(topKey),
    p: topP,
    confidence,
    runnerUp: second,
    top: ranked.slice(0, 5).map(([k, p]) => ({ tag: k, label: label(k), p })),
    reason: confidence >= tagSet.minConfidence ? "" : second ? `Unsure: ${label(topKey)} or ${second.label}` : `Unsure: ${label(topKey)}`,
  };
}

/**
 * Hold a generated tag set to the tags the person typed: every one kept, spelled as typed, in their order, with
 * the model's description where it wrote one. A model that "improves" a tag name ("PBM" for "Pharmacy / PBM")
 * would otherwise silently change the column the team filters on. Tags the model added that were not asked for
 * are dropped, except its Other.
 */
export function mergeNamedTags(generated, named) {
  if (!Array.isArray(named) || named.length < 3) return generated;
  const norm = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const byLabel = new Map((generated?.tags ?? []).map((t) => [norm(t.label), t]));
  const tags = named.map((label) => ({ label, description: byLabel.get(norm(label))?.description ?? "" }));
  const other = (generated?.tags ?? []).find((t) => t.key === "other" || /^other\b/i.test(t.label));
  if (other && !tags.some((t) => /^other\b/i.test(t.label))) tags.push({ label: other.label, description: other.description });
  return normalizeTagSet({ ...generated, tags });
}

/* ═══ Suggesting tags from "Other" ═══ */

/**
 * What the tag suggester is shown for each company that landed in Other: who it is and what it does, from the
 * list and from its own website when that was scraped. Capped, because a few hundred companies is plenty to see
 * the clusters and the call has to finish inside the function ceiling.
 */
export function otherSample(items, max = 250) {
  return (Array.isArray(items) ? items : []).slice(0, max).map((it, n) => {
    const p = it?.profile ?? {};
    const fw = p.from_website ?? {};
    return prune({
      n: n + 1,
      name: clip(p.name ?? it?.name, 100),
      industry: clip(p.industry, 100),
      what_they_do: clip(fw.what_they_do ?? p.description, 320),
      organization_type: clip(fw.organization_type ?? p.type, 80),
      customers: clip(fw.customers, 160),
      runner_up: clip(it?.runnerUp, 80),
    }) ?? {};
  });
}

/**
 * The suggester's answer, held to what can be added safely: new labels only (nothing that duplicates an existing
 * tag), each with a description, the example companies it would catch, and at most 20 of them.
 */
export function parseSuggestions(text, existingLabels = []) {
  const body = String(text ?? "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  let parsed;
  try { parsed = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)); } catch { return { suggestions: [], outOfScope: [] }; }
  const norm = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const taken = new Set(existingLabels.map(norm));
  const suggestions = [];
  for (const sug of Array.isArray(parsed?.suggestions) ? parsed.suggestions : []) {
    const label = clip(stripInstruction(sug?.label), 80);
    if (!label || taken.has(norm(label)) || /^other\b/i.test(label)) continue;
    taken.add(norm(label));
    suggestions.push({
      label,
      description: clip(sug?.description, 500),
      examples: (Array.isArray(sug?.examples) ? sug.examples : []).map((e) => clip(e, 100)).filter(Boolean).slice(0, 8),
      count: Math.max(0, Math.round(Number(sug?.count) || 0)),
    });
    if (suggestions.length >= 20) break;
  }
  const outOfScope = (Array.isArray(parsed?.out_of_scope) ? parsed.out_of_scope : []).map((e) => clip(e, 100)).filter(Boolean).slice(0, 50);
  return { suggestions, outOfScope };
}

/** New tags slotted in before Other, so Other stays the last resort in the list Jev reads. */
export function addTags(tagSet, newTags) {
  const tags = Array.isArray(tagSet?.tags) ? tagSet.tags : [];
  const other = tags.filter((t) => t.key === "other" || /^other\b/i.test(t.label));
  const rest = tags.filter((t) => !other.includes(t));
  return normalizeTagSet({ ...tagSet, tags: [...rest, ...newTags.map((t) => ({ label: t.label, description: t.description ?? "" })), ...other] });
}

/* ═══ Claude review of Other / Needs review ═══ */

/**
 * What Claude is shown for one company it is asked to place: the same facts Jev saw (list data plus scraped
 * website facts) and Jev's own top candidates, so it can confirm, correct, or reject them.
 */
export function reviewItem(id, profile, top) {
  const p = profile ?? {};
  return prune({
    id,
    name: clip(p.name, 120),
    industry: clip(p.industry, 160),
    description: clip(p.description, 700),
    products: clip(p.products, 300),
    from_website: p.from_website,
    type: clip(p.type, 60),
    employees: clip(p.employees, 30),
    location: clip(p.location, 100),
    jev_top_guesses: (Array.isArray(top) ? top : []).filter((t) => t && t.p > 0.02).slice(0, 3).map((t) => `${t.label} (${Math.round(t.p * 100)}%)`),
  }) ?? { id };
}

/** Strict JSON schema for Claude's placements: an existing tag, or a new one, never both, with a reason. */
export const REVIEW_SCHEMA = {
  type: "object", additionalProperties: false, required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "existing_tag", "new_tag_label", "new_tag_description", "confidence", "reason"],
        properties: {
          id: { type: "integer" },
          existing_tag: { type: ["string", "null"] },
          new_tag_label: { type: ["string", "null"] },
          new_tag_description: { type: ["string", "null"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          reason: { type: "string" },
        },
      },
    },
  },
};

/**
 * Claude's answer, held to the tag set: an `existing_tag` must match a real tag (case- and punctuation-
 * insensitively), a `new_tag_label` must not duplicate one, and every row asked about gets exactly one outcome.
 * A row it left out, or answered with neither, comes back as `unplaced` rather than being guessed.
 */
export function parseReview(parsed, tags, ids) {
  const norm = (x) => String(x ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const byLabel = new Map((tags ?? []).map((t) => [norm(t.label), t]));
  const wanted = new Set(ids);
  const out = new Map();
  for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
    const id = Number(r?.id);
    if (!wanted.has(id) || out.has(id)) continue;
    const reason = clip(r?.reason, 300);
    const confidence = ["high", "medium", "low"].includes(r?.confidence) ? r.confidence : "low";
    const existing = r?.existing_tag ? byLabel.get(norm(stripInstruction(r.existing_tag))) : null;
    if (existing) { out.set(id, { kind: "existing", tag: existing.key, label: existing.label, confidence, reason }); continue; }
    const label = clip(stripInstruction(r?.new_tag_label ?? ""), 80);
    const clash = label ? byLabel.get(norm(label)) : null;
    if (clash) { out.set(id, { kind: "existing", tag: clash.key, label: clash.label, confidence, reason }); continue; }
    if (label) { out.set(id, { kind: "new", tag: slugKey(label), label, description: clip(r?.new_tag_description, 400), confidence, reason }); continue; }
    out.set(id, { kind: "unplaced", confidence, reason: reason || "Claude gave no tag" });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { kind: "unplaced", confidence: "low", reason: "Claude did not answer for this company" });
  return out;
}

/**
 * New tags proposed across a whole review, merged by name: "Rehab Hospital" from one batch and "rehab hospital"
 * from another are one proposal, with every company it caught.
 */
export function mergeProposals(outcomes) {
  const byKey = new Map();
  for (const [i, o] of outcomes) {
    if (o?.kind !== "new") continue;
    const cur = byKey.get(o.tag) ?? { key: o.tag, label: o.label, description: o.description, rows: [] };
    if (!cur.description && o.description) cur.description = o.description;
    cur.rows.push(i);
    byKey.set(o.tag, cur);
  }
  return [...byKey.values()].sort((a, b) => b.rows.length - a.rows.length);
}

/* ═══ Always-keep terms ═══ */

/**
 * Terms that keep a row on the list whenever they appear anywhere in it — checked in code across every column,
 * not by Jev, because Jev reads a trimmed profile and cannot be trusted to notice two letters.
 *
 * ── Why acronyms are matched so strictly ─────────────────────────────────────────────────────────
 * "MA" is the point of the Vitalic run and a trap: it is inside "Manufacturer", "email", "Management"; it is a
 * state ("Boston, MA 02110"); it is a degree ("MA in Psychology") and a credential ("Jane Doe, MA, LPC"). So a
 * short all-caps term matches only as a whole, case-sensitive word; location, address, education, name, URL and
 * id columns are never searched; and ", MA" followed by a zip, punctuation or the end, or "MA in/from", is read as
 * a state or a degree. Longer terms ("Medicare Advantage") match case-insensitively as whole words.
 */
export function normalizeKeepTerms(raw) {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\n]/);
  return [...new Set(list.map((t) => String(t).trim()).filter((t) => t && t.length <= 60))].slice(0, 40);
}

const SKIP_COLUMN = /location|address|street|city|state|country|zip|postal|education|school|degree|grade|university|college|field of study|email|phone|mobile|url|website|domain|linkedin|twitter|facebook|instagram|picture|photo|logo|\bid\b|first name|last name|full name|^name$|birth|followers/i;
const SKIP_ROLES = new Set(["name", "first_name", "last_name", "linkedin", "website", "company_linkedin", "location", "company_location"]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One compiled matcher per term, with the acronym rules above. Returns the match index in a text, or -1. */
function termMatcher(term) {
  const acronym = /^[A-Z0-9][A-Z0-9-]{1,5}$/.test(term);
  const re = new RegExp(`(?<![A-Za-z0-9])${escapeRe(term)}(?![A-Za-z0-9])`, acronym ? "g" : "gi");
  return (text) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (acronym) {
        const before = text.slice(Math.max(0, m.index - 2), m.index);
        const after = text.slice(m.index + term.length, m.index + term.length + 8);
        // ", MA" as a state or credential: followed by a zip, punctuation, a slash or the end.
        if (/,\s?$/.test(before) && /^(\s*\d{5}|\s*[,.;)|/·]|\s*$)/.test(after)) continue;
        // "MA in Psychology", "MA from Tufts" — a degree.
        if (/^\s+(in|from)\b/i.test(after)) continue;
      }
      return m.index;
    }
    return -1;
  };
}

/**
 * The first always-keep term found anywhere in a row, with the column and a snippet around it, or null. Runs over
 * the raw cells — every column the export has, including the ones Jev never sees.
 */
export function findKeepTerm(cells, headers, plan, terms) {
  const list = normalizeKeepTerms(terms);
  if (!list.length) return null;
  const matchers = list.map((t) => [t, termMatcher(t)]);
  const roleOf = new Map((plan?.columns ?? []).map((c) => [c.idx, c.role]));
  for (let idx = 0; idx < headers.length; idx += 1) {
    const header = headers[idx];
    if (SKIP_COLUMN.test(header) || SKIP_ROLES.has(roleOf.get(idx))) continue;
    const text = String((Array.isArray(cells) ? cells[idx] : cells?.[header]) ?? "");
    if (!text) continue;
    for (const [term, match] of matchers) {
      const at = match(text);
      if (at >= 0) {
        const start = Math.max(0, at - 50);
        return { term, column: header, snippet: `${start ? "…" : ""}${text.slice(start, at + term.length + 50).replace(/\s+/g, " ").trim()}${at + term.length + 50 < text.length ? "…" : ""}` };
      }
    }
  }
  return null;
}

/** A row that mentions an always-keep term is never dropped: a Bad verdict becomes Maybe, and says why. */
export function applyKeepTerm(verdict, reason, match) {
  if (!match) return { verdict, reason };
  const why = `Kept: mentions "${match.term}" in ${match.column}`;
  if (verdict === "bad") return { verdict: "borderline", reason: `${why} (Jev: ${reason})` };
  return { verdict, reason: reason ? `${reason} · ${why}` : why };
}

/**
 * Everything Jev answered for one row, compact enough to stream and to export: for a yes/no question the
 * probability of "yes"; for a choice the option it picked, that option's probability, the runner-up, and Jev's
 * confidence in the whole distribution.
 */
export function compactAnswers(questions, answers) {
  const out = {};
  for (const q of Array.isArray(questions) ? questions : []) {
    const a = answers?.[q.key];
    if (!a) continue;
    if (q.type === "noul") { const p = Number(a.noul ?? a.probability); if (Number.isFinite(p)) out[q.key] = { yes: p }; continue; }
    const ranked = Object.entries(a.probabilities ?? {}).map(([k, v]) => [k, Number(v) || 0]).sort((x, y) => y[1] - x[1]);
    out[q.key] = prune({ choice: ranked[0]?.[0] ?? a.choice, p: ranked[0]?.[1], second: ranked[1] && ranked[1][1] > 0.01 ? `${ranked[1][0]} ${Math.round(ranked[1][1] * 100)}%` : undefined, confidence: Number.isFinite(Number(a.confidence)) ? Number(a.confidence) : undefined }) ?? {};
  }
  return out;
}

/* ═══ Claude review of maybe contacts ═══ */

/** Strict schema for Claude's call on each maybe contact: keep or drop, how sure, and why. */
export const CONTACT_REVIEW_SCHEMA = {
  type: "object", additionalProperties: false, required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "decision", "confidence", "reason"],
        properties: { id: { type: "integer" }, decision: { type: "string", enum: ["keep", "drop"] }, confidence: { type: "string", enum: ["high", "medium", "low"] }, reason: { type: "string" } },
      },
    },
  },
};

/** One maybe contact as Claude sees it: the profile Jev read, Jev's score on each question, and any always-keep hit. */
export function contactReviewItem(id, profile, questions, scores, keep) {
  const jev = {};
  for (const q of Array.isArray(questions) ? questions : []) {
    const p = scores?.[q.key];
    if (typeof p === "number") jev[q.label] = `${Math.round(p * 100)}%`;
  }
  return { id, profile: profile ?? {}, jev_scores: jev, ...(keep ? { always_keep_match: `"${keep.term}" in ${keep.column}: ${keep.snippet}` } : {}) };
}

/** Claude's decisions, one per contact asked about; anything missing or malformed is left undecided, never guessed. */
export function parseContactReview(parsed, ids) {
  const wanted = new Set(ids);
  const out = new Map();
  for (const r of Array.isArray(parsed?.results) ? parsed.results : []) {
    const id = Number(r?.id);
    if (!wanted.has(id) || out.has(id) || !["keep", "drop"].includes(r?.decision)) continue;
    out.set(id, { decision: r.decision, confidence: ["high", "medium", "low"].includes(r?.confidence) ? r.confidence : "low", reason: clip(r?.reason, 300) });
  }
  return out;
}

/** A tag set out of a model's reply. */
export function parseGeneratedTagSet(text) {
  const body = String(text ?? "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return normalizeTagSet({});
  try { return normalizeTagSet(JSON.parse(body.slice(start, end + 1))); } catch { return normalizeTagSet({}); }
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
 * Equal-weight scoring: each answered question contributes its fit probability once — an exclusion's is already
 * "not excluded" — and "can't tell" answers sit out. Good at or above the keep line, out below the drop line,
 * "maybe" in between. A company-size range, when set, counts as one more question (0 outside, 1 inside) instead
 * of a veto.
 */
function weightedVerdict(questions, answers, thresholds, context) {
  const scores = {};
  const counted = [];
  const unclear = [];
  let missing = null;
  let failedMust = null;
  for (const q of questions) {
    const answer = answers?.[q.key];
    const p = passProbability(q, answer);
    scores[q.key] = p;
    if (p === null) { missing ??= q; continue; }
    if (neutralShare(q, answer) >= 0.5) { unclear.push(q); continue; }
    // A must-have is the one hard line even in weighted mode ("director and up only"); everything else is a vote.
    if (q.kind === "must" && p < thresholds.drop && (!failedMust || p < failedMust.p)) failedMust = { label: q.label, p };
    counted.push({ label: q.label, p });
  }
  if (failedMust) return { verdict: "bad", reason: `Failed: ${failedMust.label}`, scores, score: counted.reduce((n, c) => n + c.p, 0) / counted.length };
  const size = sizeCheck(context.icp, context.profile);
  if (size) counted.push({ label: "Company size", p: size === "inside" ? 1 : 0 });
  const note = unclear.length ? ` · can't tell: ${unclear.map((q) => q.label).join(", ")}` : "";
  if (!counted.length) return { verdict: "borderline", reason: missing ? `No answer: ${missing.label}` : `Not enough data to judge${note}`, scores, score: null };
  const score = counted.reduce((n, c) => n + c.p, 0) / counted.length;
  const weakest = counted.reduce((w, c) => (c.p < w.p ? c : w));
  const pctOf = (x) => `${Math.round(x * 100)}%`;
  if (score >= thresholds.keep && !missing) return { verdict: "good", reason: note ? note.slice(3) : "", scores, score };
  if (score < thresholds.drop) return { verdict: "bad", reason: `Score ${pctOf(score)} — weakest: ${weakest.label}${note}`, scores, score };
  return { verdict: "borderline", reason: `Maybe — score ${pctOf(score)}, weakest: ${weakest.label}${note}`, scores, score };
}

/** How much of a choice answer landed on "can't tell" options. */
function neutralShare(question, answer) {
  if (question.type !== "choice" || !question.neutral?.length) return 0;
  const probs = answer?.probabilities ?? {};
  return question.neutral.reduce((n, k) => n + (Number(probs[k]) || 0), 0);
}

/** Below this, an exclusion's "fit" probability means the disqualifier is clearly true (≥80% sure). */
export const EXCLUDE_LINE = 0.2;

/**
 * Combine one row's answers into `{ verdict: "good" | "borderline" | "bad", reason, scores, score }`.
 *
 * ── Why this is a score with vetoes, not an all-must-pass gate ───────────────────────────────────
 * The first version required every question to clear 60%. With six questions that compounds — six questions
 * each passing 75% of real targets would keep under 20% of them — and a live Bluevia list of 500 already-vetted
 * contacts came back 20 good fits (4%). So now:
 * - a `must` question drops a contact only on a clear fail (below the drop line);
 * - an `exclude` question drops them only when the disqualifier is clearly true;
 * - a choice answered mostly "can't tell" counts for nothing either way — thin data is not evidence of a bad fit;
 * - the company size range is checked in code; an unknown size is left out, not failed;
 * - with must-haves, good means every must-have clears the keep line; signals only rank, via `score`;
 * - with no must-have, the averaged score decides good vs borderline.
 */
export function verdictFor(questions, answers, thresholds = DEFAULT_THRESHOLDS, context = {}) {
  if (context.scoring === "weighted") return weightedVerdict(questions, answers, thresholds, context);
  const scores = {};
  const counted = [];
  const unclear = [];
  let excluded = null;
  let failed = null;
  let missing = null;
  for (const q of questions) {
    const answer = answers?.[q.key];
    const p = passProbability(q, answer);
    scores[q.key] = p;
    if (p === null) { missing ??= q; continue; }
    if (neutralShare(q, answer) >= 0.5) { unclear.push(q); continue; }
    const kind = q.kind ?? (q.type === "noul" && q.pass === false ? "exclude" : "must");
    if (kind === "exclude") { if (p < EXCLUDE_LINE && (!excluded || p < excluded.p)) excluded = { q, p }; continue; }
    if (kind === "must" && p < thresholds.drop && (!failed || p < failed.p)) failed = { q, p };
    counted.push({ q, p, kind });
  }
  const size = sizeCheck(context.icp, context.profile);
  if (size === "outside") return { verdict: "bad", reason: `Company size outside ${context.icp.sizeMin ?? 0}–${context.icp.sizeMax ?? "any"} employees`, scores, score: null };
  if (excluded) return { verdict: "bad", reason: `Excluded: ${excluded.q.label}`, scores, score: null };
  if (failed) return { verdict: "bad", reason: `Failed: ${failed.q.label}`, scores, score: null };
  if (!counted.length) return { verdict: "borderline", reason: missing ? `No answer: ${missing.label}` : "Not enough data to judge", scores, score: null };
  const score = counted.reduce((n, c) => n + c.p, 0) / counted.length;
  const note = unclear.length ? ` · can't tell: ${unclear.map((q) => q.label).join(", ")}` : "";
  /*
   * With must-haves, they alone decide good vs borderline; signals only rank (the `score`). A Vitalic test put
   * "VP of Provider Growth at a Medicaid-focused company" in Borderline: it passed "any Medicare/Medicaid
   * connection" but a generic title failed the "own role handles it" signal, and averaging let the signal sink a
   * contact the list exists to keep. Without any must-have, the average is all there is, so it decides.
   */
  const musts = counted.filter((c) => c.kind === "must");
  if (musts.length) {
    const weakMust = musts.reduce((w, c) => (c.p < w.p ? c : w));
    if (weakMust.p >= thresholds.keep && !missing) return { verdict: "good", reason: note ? note.slice(3) : "", scores, score };
    return { verdict: "borderline", reason: missing ? `No answer: ${missing.label}${note}` : `Unsure: ${weakMust.q.label} (${Math.round(weakMust.p * 100)}%)${note}`, scores, score };
  }
  const weakest = counted.reduce((w, c) => (c.p < w.p ? c : w));
  if (score >= thresholds.keep && !missing) return { verdict: "good", reason: note ? note.slice(3) : "", scores, score };
  return { verdict: "borderline", reason: `Score ${Math.round(score * 100)}% — weakest: ${weakest.q.label}${note}`, scores, score };
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
