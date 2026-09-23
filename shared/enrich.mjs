// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The pure half of Jev's enrichment pipeline: which rows need more data, where to get it, what the structuring
 * model must return, and how its answer is folded back into the profile Jev reads. No I/O, so
 * `tests/enrich.test.mjs` drives all of it.
 *
 * ── The cascade, and why it runs Jev twice ────────────────────────────────────────────────────────
 *   CSV row → Jev first pass → (only if needed) scrape → cheap LLM structures → Jev final pass
 * The first pass costs ~$0.00005 a row and answers two questions at once: is this row already decided, and is
 * the data thin? A contact Jev confidently rules out on their title alone is not worth a paid LinkedIn scrape;
 * a confident "good fit" built on a title and nothing else is exactly how bad fits got into lists, so thin data
 * is scraped even when the first pass liked it.
 *
 * ── Why the model structures but never enriches ──────────────────────────────────────────────────
 * The LLM is only ever shown text we scraped and is told to return null for anything the text does not say.
 * Asked to "enrich" from memory it invents headcounts and funding rounds for small companies with total
 * confidence, and Jev would then classify fiction. Every non-null field comes with a verbatim quote.
 */

const clip = (value, max) => {
  const s = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value == null ? "" : String(value).trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
};

export const ENRICH_MODES = { auto: "Auto — only rows that need it", all: "Every row with a URL", off: "Off — CSV data only" };

/* ═══ Where to scrape ═══ */

/** A LinkedIn profile URL in the canonical /in/<slug> form, or "" — Sales Navigator and company pages are not profiles. */
export function linkedinProfileUrl(raw) {
  const s = String(raw ?? "").trim();
  const m = s.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? `https://www.linkedin.com/in/${decodeURIComponent(m[1]).replace(/\/+$/, "")}/` : "";
}

/** A company website as an https URL on its bare host, or "" when the value is not a usable site. */
export function websiteUrl(raw) {
  let s = String(raw ?? "").trim();
  if (!s || /\s/.test(s)) return "";
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/\./.test(u.hostname) || /(^|\.)linkedin\.com$|(^|\.)facebook\.com$|(^|\.)twitter\.com$|(^|\.)x\.com$/i.test(u.hostname)) return "";
    return `https://${u.hostname.replace(/^www\./i, "")}${u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return "";
  }
}

/** The one URL worth scraping for a row: a person's LinkedIn profile, or a company's own website. */
export function scrapeTarget(mode, person) {
  return mode === "companies" ? websiteUrl(person?.company ? `https://${person.company}` : person?.linkedin) : linkedinProfileUrl(person?.linkedin);
}

/* ═══ Does this row need it? ═══ */

const has = (v, min = 1) => (typeof v === "string" ? v.trim().length >= min : Array.isArray(v) ? v.length > 0 : v && typeof v === "object" ? Object.keys(v).length > 0 : v != null);
const at = (p, path) => path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), p);

/**
 * What a row is missing for Jev to judge it well. A contact needs something the person wrote about themselves
 * (headline or About) plus whatever the client's questions name; a company needs a real description of what it
 * does — one line of industry is what off-the-shelf tools already give and is the problem, not the answer.
 */
export function missingData(mode, profile, requiredFields = []) {
  const p = profile ?? {};
  const missing = [];
  if (mode === "companies") {
    const desc = [p.description, p.products, p.from_website?.what_they_do].filter(Boolean).join(" ");
    if (desc.trim().length < 160) missing.push("description");
  } else {
    if (!has(p.headline, 8) && !has(p.about, 60) && !has(p.from_linkedin)) missing.push("headline or about");
    if (!has(p.current_roles)) missing.push("current_roles");
  }
  for (const f of requiredFields) if (!has(at(p, f)) && !missing.includes(f)) missing.push(f);
  return missing;
}

/**
 * After the first pass: is this row done, or does it go on to be enriched?
 * - `ruled_out`: Jev is sure it does not fit on what it already has — never pay to scrape it.
 * - `decided`: confident, and the data behind it is not thin.
 * - `enrich`: unsure, or confident on thin data.
 */
export function afterFirstPass(mode, result, missing, enrichMode = "auto") {
  if (enrichMode === "off") return "decided";
  if (enrichMode === "all") return "enrich";
  if (!result || result.status === "error") return "enrich";
  if (mode === "companies") return result.status === "tagged" && !missing.length ? "decided" : "enrich";
  const scores = Object.values(result.scores ?? {}).filter((s) => typeof s === "number");
  // Ruled out only on a clear fail (well under the drop line), so a borderline "bad" still gets a second look.
  if (result.status === "bad" && scores.length && Math.min(...scores) < 0.15) return "ruled_out";
  return result.status === "good" && !missing.length ? "decided" : "enrich";
}

/* ═══ Reading pages ═══ */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', mdash: "—", ndash: "–", hellip: "…" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") { const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

/**
 * A web page as the text a person would read: title, meta description, then the visible body with scripts,
 * styles, navigation chrome and markup removed. Capped, because a homepage's first few thousand characters say
 * what a company does and the rest is footers and cookie banners.
 */
export function htmlToText(html, max = 8_000) {
  const src = String(html ?? "");
  const title = decode((src.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] ?? "").replace(/\s+/g, " ").trim();
  const metaOf = (name) => decode((src.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)`, "i")) || src.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, "i")) || [])[1] ?? "").trim();
  const description = metaOf("description") || metaOf("og:description");
  const body = decode(
    src
      .replace(/<head[\s>][\s\S]*?<\/head>/i, " ")
      .replace(/<(script|style|noscript|svg|template|iframe|canvas)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(nav|footer)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(br|p|div|li|h[1-6]|section|article|tr|td|header|main|blockquote)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).replace(/[ \t\u00a0]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{2,}/g, "\n").trim();
  return { title, description, text: body.length > max ? body.slice(0, max) : body };
}

/**
 * Pages that came back but are not the company talking: bot walls, error pages, parked domains. Feeding one to
 * the structuring model produced "customers: Not Acceptable! An appropriate representation…" in testing.
 */
export function unusablePage(page, status = 200) {
  const t = `${page?.title ?? ""} ${page?.text ?? ""}`.slice(0, 1_500).toLowerCase();
  if (status >= 400) return `HTTP ${status}`;
  if ((page?.text ?? "").trim().length < 120 && !(page?.description ?? "").trim()) return "page had almost no text";
  const walls = [
    ["not acceptable", "blocked by the site's firewall"], ["access denied", "blocked by the site"], ["attention required", "behind a bot check"],
    ["just a moment", "behind a bot check"], ["verify you are human", "behind a bot check"], ["enable javascript", "needs JavaScript to show anything"],
    ["domain is for sale", "domain is parked"], ["this domain may be for sale", "domain is parked"], ["buy this domain", "domain is parked"],
    ["404 not found", "page not found"], ["page not found", "page not found"], ["site can't be reached", "site is down"], ["account suspended", "site is suspended"],
  ];
  for (const [needle, why] of walls) if (t.includes(needle) && (page?.text ?? "").length < 2_500) return why;
  return "";
}

/* ═══ What the structuring model returns ═══ */

const nullable = { type: ["string", "null"] };
const evidence = { type: "array", maxItems: 4, items: { type: "object", additionalProperties: false, required: ["field", "quote"], properties: { field: { type: "string" }, quote: { type: "string" } } } };

/** JSON schema (strict) for one row's extraction. Every field is required-but-nullable, so absence is explicit. */
export function structureSchema(mode) {
  if (mode === "companies") {
    return {
      type: "object", additionalProperties: false,
      required: ["what_they_do", "industry", "products", "customers", "organization_type", "employees", "locations", "evidence"],
      properties: { what_they_do: nullable, industry: nullable, products: nullable, customers: nullable, organization_type: nullable, employees: nullable, locations: nullable, evidence },
    };
  }
  const role = { type: "object", additionalProperties: false, required: ["title", "company", "since"], properties: { title: nullable, company: nullable, since: nullable } };
  return {
    type: "object", additionalProperties: false,
    required: ["headline", "about", "current_title", "current_company", "current_roles", "location", "evidence"],
    properties: { headline: nullable, about: nullable, current_title: nullable, current_company: nullable, current_roles: { type: "array", maxItems: 4, items: role }, location: nullable, evidence },
  };
}

export const STRUCTURE_PROMPT = {
  companies: `You turn a company's own website text into facts for a classifier. Use ONLY the text given. If the text does not state something, return null — never infer, never use outside knowledge, never estimate numbers. Keep each field under 40 words, in plain language.
- what_they_do: what the organization actually does or sells, one or two sentences.
- industry: the specific kind of organization (e.g. "behavioral health EHR software", "outpatient addiction treatment provider"), not a broad sector.
- products: its main products or services.
- customers: who it serves or sells to.
- organization_type: e.g. nonprofit provider, software vendor, clinic group, health plan, government agency, association, school.
- employees, locations: only if the text states them.
- evidence: up to 4 verbatim quotes, each under 20 words, from the text that support the non-null fields.`,
  contacts: `You turn a scraped LinkedIn profile record into facts for a classifier. Use ONLY the record given. If it does not state something, return null — never infer or use outside knowledge. Keep each field under 60 words.
- headline: the person's own LinkedIn headline.
- about: a faithful condensation of their About section.
- current_title / current_company: their main job now, as the record states it.
- current_roles: every job the record marks as current (or with no end date), most important first.
- location: as stated.
- evidence: up to 4 verbatim quotes, each under 20 words, from the record that support the non-null fields.`,
};

/**
 * Several rows in one model call. The per-row schema gains an `id`, and the prompt forbids carrying a fact from one
 * row to another. Batching exists because OpenRouter caps new accounts at 20 requests a minute per model: one row
 * a call is 20 companies a minute, six a call is 120.
 */
export function structureBatchSchema(mode) {
  const row = structureSchema(mode);
  return {
    type: "object", additionalProperties: false, required: ["rows"],
    properties: { rows: { type: "array", items: { ...row, required: ["id", ...row.required], properties: { id: { type: "integer" }, ...row.properties } } } },
  };
}

export const BATCH_RULES = `\n\nYou will receive several sources, each starting with "=== ROW <id> ===". Return exactly one object per row in "rows", with its id. Each row is a different ${"${subject}"}: never use text from one row to fill another row's fields.`;
export const batchPrompt = (mode) => STRUCTURE_PROMPT[mode] + BATCH_RULES.replace("${subject}", mode === "companies" ? "company" : "person");

/** The user message for a batch: each row's source under its id. */
export function structureBatchInput(mode, items, maxPerRow = 6_000) {
  return items.map((it) => `=== ROW ${it.i} ===\n${structureInput(mode, it.profile, it.source).slice(0, maxPerRow)}`).join("\n\n");
}

/** The model's batch answer as a map of row id → that row's fields; rows it left out are simply absent. */
export function splitBatchAnswer(parsed, ids) {
  const out = new Map();
  const wanted = new Set(ids);
  for (const row of Array.isArray(parsed?.rows) ? parsed.rows : []) {
    const id = Number(row?.id);
    if (!wanted.has(id) || out.has(id)) continue;
    const { id: _id, ...fields } = row;
    void _id;
    out.set(id, fields);
  }
  return out;
}

/** The user message for one row: the source text, plus what the CSV already says so the model knows who this is. */
export function structureInput(mode, profile, source) {
  const known = mode === "companies"
    ? { name: profile?.name, industry: profile?.industry }
    : { listed_title: profile?.listed_title, listed_company: profile?.listed_company };
  const body = source?.kind === "linkedin" ? JSON.stringify(source.record ?? {}, null, 1).slice(0, 12_000) : [source?.title && `TITLE: ${source.title}`, source?.description && `META DESCRIPTION: ${source.description}`, source?.text].filter(Boolean).join("\n\n").slice(0, 12_000);
  return `WHO THIS IS (from the list, for reference only): ${JSON.stringify(known)}\nSOURCE: ${source?.url ?? ""}\n\n${body}`;
}

/**
 * Fold the model's answer into the profile Jev reads. Website facts sit under `from_website` and LinkedIn facts
 * fill the contact fields the CSV left empty — the CSV is never overwritten, because the list is what the team
 * pulled and a stale scrape should not silently replace it. Returns which fields were added.
 */
export function mergeStructured(mode, profile, structured) {
  const out = JSON.parse(JSON.stringify(profile ?? {}));
  const filled = [];
  const s = structured && typeof structured === "object" ? structured : {};
  const val = (v, max) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? clip(v, max) : "");
  if (mode === "companies") {
    const fw = {};
    for (const [k, max] of [["what_they_do", 400], ["industry", 120], ["products", 300], ["customers", 250], ["organization_type", 100], ["employees", 40], ["locations", 150]]) {
      const v = val(s[k], max);
      if (v) { fw[k] = v; filled.push(k); }
    }
    if (Object.keys(fw).length) out.from_website = fw;
    return { profile: out, filled };
  }
  for (const [k, max] of [["headline", 220], ["about", 600], ["location", 100]]) {
    const v = val(s[k], max);
    if (v && !has(out[k])) { out[k] = v; filled.push(k); }
  }
  const roles = (Array.isArray(s.current_roles) ? s.current_roles : [])
    .map((r) => ({ title: val(r?.title, 140), company: val(r?.company, 120), since: val(r?.since, 20), employment_type: val(r?.employment_type, 40) }))
    .filter((r) => r.title || r.company)
    .map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v)));
  if (!roles.length && (val(s.current_title, 140) || val(s.current_company, 120))) {
    roles.push(Object.fromEntries(Object.entries({ title: val(s.current_title, 140), company: val(s.current_company, 120) }).filter(([, v]) => v)));
  }
  if (roles.length && !has(out.current_roles)) { out.current_roles = roles.slice(0, 4); filled.push("current_roles"); }
  // What LinkedIn says the person does now is kept beside the list's claim, so a question can compare the two —
  // that disagreement is the "I don't work in that space" reply, caught before it is sent.
  const now = Object.fromEntries(Object.entries({ title: val(s.current_title, 140), company: val(s.current_company, 120) }).filter(([, v]) => v));
  if (Object.keys(now).length) { out.from_linkedin = now; filled.push("from_linkedin"); }
  return { profile: out, filled };
}

/** Evidence quotes from the model, cleaned for display. */
export function evidenceOf(structured) {
  return (Array.isArray(structured?.evidence) ? structured.evidence : [])
    .map((e) => (typeof e === "string" ? { field: "", quote: clip(e, 200) } : { field: clip(e?.field, 40), quote: clip(e?.quote, 200) }))
    .filter((e) => e.quote)
    .slice(0, 4);
}

/* ═══ AI Ark people ═══ */

/**
 * A contact's facts straight from an AI Ark People Search record — no model in between.
 *
 * AI Ark returns the profile already structured: headline, summary, every position with its dates and employment
 * type, the current company's own description, staff range and keywords, and department/seniority. Running that
 * through an LLM would only add cost, latency and a chance of paraphrasing a fact wrong, so contacts are mapped in
 * code and only company websites go to the structuring model.
 *
 * A position counts as current when its end date is empty. Its employment type is kept because it is the tell
 * this pipeline exists to catch: a "Freelance" advisory-board seat listed as the contact's company.
 */
export function aiArkFacts(personValue) {
  const person = personValue && typeof personValue === "object" ? personValue : {};
  const profile = person.profile ?? {};
  const str = (v, max = 300) => (typeof v === "string" && v.trim() ? clip(v, max) : null);
  const roles = [];
  for (const group of Array.isArray(person.position_groups) ? person.position_groups : []) {
    for (const pos of Array.isArray(group?.profile_positions) ? group.profile_positions : []) {
      if (pos?.date?.end) continue;
      const role = { title: str(pos?.title, 140), company: str(pos?.company || group?.company?.name, 120), since: str(pos?.date?.start, 10), employment_type: str(pos?.employment_type, 40) };
      if (role.title || role.company) roles.push(role);
    }
  }
  const co = person.company?.summary ?? {};
  const staff = co.staff?.range;
  const keywords = Array.isArray(person.company?.keywords) ? person.company.keywords.slice(0, 12).join(", ") : "";
  const dept = person.department ?? {};
  return {
    headline: str(profile.headline, 220),
    about: str(profile.summary, 600),
    current_title: str(profile.title, 140),
    current_company: str(co.name, 120) ?? roles[0]?.company ?? null,
    current_roles: roles.slice(0, 4),
    location: str(person.location?.default ?? person.location?.short, 100),
    seniority: str(dept.seniority, 40),
    department: Array.isArray(dept.departments) && dept.departments.length ? clip(dept.departments.join(", "), 80) : null,
    company_description: str(co.description, 500),
    company_industry: str(co.industry, 100),
    company_employees: staff && (staff.start || staff.end) ? `${staff.start ?? ""}-${staff.end ?? ""}` : null,
    company_products: keywords ? clip(keywords, 250) : null,
    evidence: [],
  };
}

/**
 * Fold AI Ark's facts into the profile. As with the model path, the CSV is never overwritten — AI Ark fills what
 * the list left empty, and adds `from_linkedin` so a question can compare the listed company with the real one.
 */
export function mergeAiArk(profile, person) {
  const facts = aiArkFacts(person);
  const { profile: merged, filled } = mergeStructured("contacts", profile, facts);
  for (const [k, v] of [["seniority", facts.seniority], ["department", facts.department]]) {
    if (v && !has(merged[k])) { merged[k] = v; filled.push(k); }
  }
  // The employer's own description only applies when AI Ark's current company is the one the list names; for
  // anyone else it would describe the wrong organisation.
  const listed = String(merged.listed_company ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const current = String(facts.current_company ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (listed && current && (listed.includes(current) || current.includes(listed))) {
    const lcp = { ...(merged.listed_company_profile ?? {}) };
    for (const [k, v] of [["description", facts.company_description], ["industry", facts.company_industry], ["employees", facts.company_employees], ["products", facts.company_products]]) {
      if (v && !has(lcp[k])) { lcp[k] = v; filled.push(`listed_company_profile.${k}`); }
    }
    if (Object.keys(lcp).length) merged.listed_company_profile = lcp;
  }
  if (Array.isArray(merged.current_roles)) merged.current_roles = merged.current_roles.map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v)));
  return { profile: merged, filled, facts };
}

/** AI Ark's quotable lines for the evidence panel: its own headline and title, verbatim. */
export function aiArkEvidence(facts) {
  return [["headline", facts?.headline], ["title", facts?.current_title], ["company", facts?.current_company]]
    .filter(([, v]) => v)
    .map(([field, quote]) => ({ field, quote: clip(quote, 200) }));
}
