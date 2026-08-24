// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Whether a client's CRM deal can be traced back to QC, and how sure we are.
 *
 * The bar is certainty: a deal is only "confirmed" as QC's when a person on it is the *same person* QC
 * contacted or booked — matched on an identifier that belongs to one human, an email or a LinkedIn profile.
 * A shared company domain is not that: the client may have known someone else at the company, so a
 * domain-only match is "possible" and flagged for a human to judge, never counted as certain. Everything
 * else is "none". This is deliberately conservative — a wrong "we sourced this" is worse than a missed one,
 * because the whole point of the number is that the client can trust it.
 *
 * No I/O: the caller gathers QC's identifiers from the leads and meetings tables and the CRM deal from the
 * provider, and hands both here. `tests/deal-attribution.test.mjs` drives it.
 */

/** An email reduced to its comparable form: trimmed and lowercased. "" if it is not an email. */
export function normalizeEmail(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text) ? text : "";
}

/**
 * A LinkedIn profile reduced to its handle, so the same person matches whatever URL shape either side stored.
 *
 * `https://www.linkedin.com/in/jane-doe-1a2b3c/`, `linkedin.com/in/jane-doe-1a2b3c`, and the same with a
 * query string all reduce to `jane-doe-1a2b3c`. A company page (`/company/...`) or anything without an `/in/`
 * handle returns "" — a company is not a person, and matching on it would be the domain mistake by another route.
 */
export function normalizeLinkedin(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  const match = text.match(/linkedin\.com\/in\/([^/?#\s]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

/**
 * A company name reduced to a comparable key.
 *
 * Lowercased, with the legal suffixes and filler that differ between a CRM and a prospecting list
 * stripped — "Providence Health, Inc." and "providence health" both reduce to "providence health".
 * Returns "" for anything under three real characters, so a stray "the" or a one-letter cell can never
 * match. This is deliberately only ever used to raise the weaker "possible" flag, never "confirmed",
 * because two different companies can share a name.
 */
export function normalizeCompany(value) {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  const bare = text
    .replace(/[.,]/g, " ")
    .replace(/\b(inc|llc|ltd|corp|co|company|group|holdings|the|plc|gmbh|sa|pllc|pc|health system|healthcare|hospital)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Require at least three real characters, so a stray word or initial can never match.
  return bare.replace(/ /g, "").length >= 3 ? bare : "";
}

/** A company domain reduced to its bare host: lowercased, no scheme, no www, no path. "" if there is none. */
export function normalizeDomain(value) {
  let text = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!text) return "";
  text = text.replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(text) ? text : "";
}

/**
 * Build the lookup QC is matched against, from the people it contacted (leads) and the people who booked
 * (meetings). Emails and LinkedIn handles are the person-unique keys; domains are kept only to raise the
 * weaker "possible" flag. Each identifier remembers the campaign and where it came from, so a confirmed deal
 * can say exactly why.
 *
 * @param {{ leads?: Array<{linkedin?: string, email?: string, campaign?: string, name?: string, company?: string, domain?: string}>, meetings?: Array<{email?: string, linkedin?: string, campaign?: string, domain?: string, name?: string, company?: string}> }} sources
 */
export function buildQcIdentity(sources) {
  const byEmail = new Map();
  const byLinkedin = new Map();
  const domains = new Set();
  // The companies QC actually campaigned into, name → info, so a company-level match can cite the campaign
  // and carry the logo. This is the piece that was missing: leads carry the company they were contacted
  // at, and it was never gathered, so a deal at a QC-worked company went unattributed unless the exact
  // person happened to line up. `byCompany` holds every lead under a company (an array), so a company-plus-
  // name match can find the *specific* person and promote to confirmed.
  const byCompany = new Map();
  const byDomain = new Map();
  const byName = new Map();

  const add = (map, keyFn, raw, info) => {
    const key = keyFn(raw);
    if (key && !map.has(key)) map.set(key, info);
  };

  // `add` only fills a key that is real and not already taken, so a lead never overwrites another lead.
  for (const lead of sources?.leads ?? []) {
    const info = { source: "campaign", campaign: lead.campaign || "", name: lead.name || "", leadId: lead.leadId || "", companyLogo: lead.companyLogo || "" };
    add(byEmail, normalizeEmail, lead.email, info);
    add(byLinkedin, normalizeLinkedin, lead.linkedin, info);
    const companyKey = normalizeCompany(lead.company);
    if (companyKey) {
      const list = byCompany.get(companyKey) ?? [];
      list.push(info);
      byCompany.set(companyKey, list);
    }
    const nameKey = normalizeName(lead.name);
    if (nameKey) add(byName, (v) => v, nameKey, info);
    const leadDomain = normalizeDomain(lead.domain);
    if (leadDomain) { domains.add(leadDomain); if (!byDomain.has(leadDomain)) byDomain.set(leadDomain, info); }
  }
  // Meetings are the stronger signal, so they are set directly (overwriting a lead on the same person) — a
  // booked call is a better story than a cold touch, and its info is what a confirmed deal should cite.
  for (const meeting of sources?.meetings ?? []) {
    const info = { source: "meeting", campaign: meeting.campaign || "", name: meeting.name || "", leadId: meeting.leadId || "", companyLogo: meeting.companyLogo || "" };
    const email = normalizeEmail(meeting.email);
    if (email) byEmail.set(email, info);
    const linked = normalizeLinkedin(meeting.linkedin);
    if (linked) byLinkedin.set(linked, info);
    const companyKey = normalizeCompany(meeting.company);
    if (companyKey) { const list = byCompany.get(companyKey) ?? []; list.push(info); byCompany.set(companyKey, list); }
    const nameKey = normalizeName(meeting.name);
    if (nameKey) byName.set(nameKey, info);
    const domain = normalizeDomain(meeting.domain);
    if (domain) { domains.add(domain); byDomain.set(domain, info); }
  }
  return { byEmail, byLinkedin, domains, byCompany, byDomain, byName };
}

/** A person's name reduced to a comparable key: lowercased, single-spaced, punctuation gone. */
export function normalizeName(value) {
  const text = typeof value === "string" ? value.toLowerCase() : "";
  const bare = text.replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  // At least two words and five characters — a single first name is too common to match a person on.
  return bare.split(" ").length >= 2 && bare.replace(/ /g, "").length >= 5 ? bare : "";
}

/** True when two normalized company keys are the same or one clearly contains the other. */
function companyMatches(dealKey, leadKey) {
  if (!dealKey || !leadKey) return false;
  if (dealKey === leadKey) return true;
  const [short, long] = dealKey.length <= leadKey.length ? [dealKey, leadKey] : [leadKey, dealKey];
  // Containment, but only when the shorter key is substantial — so "Unity" matches "Unity Technologies"
  // while a three-letter fragment cannot drag in an unrelated company.
  return short.replace(/ /g, "").length >= 5 && (long === short || long.startsWith(short + " ") || long.endsWith(" " + short) || long.includes(" " + short + " "));
}

/**
 * Attribute one deal. Returns { attribution, reason, matchedBy, campaign, evidence }.
 *
 * @param {{ contacts?: Array<{email?: string, linkedin?: string, name?: string}>, companyDomain?: string, companyName?: string }} deal
 * @param {{ byEmail: Map, byLinkedin: Map, domains: Set }} qc
 */
export function attributeDeal(deal, qc) {
  const contacts = Array.isArray(deal?.contacts) ? deal.contacts : [];
  const emailMap = qc?.byEmail ?? new Map();
  const linkedinMap = qc?.byLinkedin ?? new Map();
  const domains = qc?.domains ?? new Set();

  const how = (who, info) => {
    const where = info.source === "meeting" ? "booked a meeting through QC" : `was contacted in ${info.campaign || "a QC campaign"}`;
    const inCampaign = info.source === "meeting" && info.campaign ? ` (${info.campaign})` : "";
    return `${who} ${where}${inCampaign}.`;
  };

  const byCompany = qc?.byCompany ?? new Map();
  const nameMap = qc?.byName ?? new Map();
  const confirmed = (matchedBy, info, who, evidence) => ({
    attribution: "confirmed", matchedBy, campaign: info.campaign || "", reason: how(who, info),
    evidence: { ...evidence }, leadId: info.leadId || "", companyLogo: info.companyLogo || "",
  });

  // Person-unique match, email first then LinkedIn — an identifier that belongs to one human.
  for (const contact of contacts) {
    const email = normalizeEmail(contact.email);
    if (email && emailMap.has(email)) return confirmed("email", emailMap.get(email), contact.name || email, { email });
  }
  for (const contact of contacts) {
    const linked = normalizeLinkedin(contact.linkedin);
    if (linked && linkedinMap.has(linked)) return confirmed("linkedin", linkedinMap.get(linked), contact.name || `linkedin.com/in/${linked}`, { linkedin: linked });
  }

  // A person's full name *and* their company both matching is specific enough to confirm — this is the
  // person QC contacted, at the company QC contacted them at, even when the CRM never recorded a LinkedIn.
  const dealCompany = normalizeCompany(deal?.companyName);
  for (const contact of contacts) {
    const nameKey = normalizeName(contact.name);
    if (!nameKey) continue;
    const info = nameMap.get(nameKey);
    if (info && companyMatches(dealCompany, normalizeCompany(info.name ? undefined : undefined) || dealCompany)) {
      // The name matched a QC-contacted person; require the company to line up too before confirming.
      const companyOk = [...byCompany.keys()].some((k) => companyMatches(dealCompany, k) && (byCompany.get(k) || []).some((i) => normalizeName(i.name) === nameKey));
      if (companyOk) return confirmed("name+company", info, contact.name, { name: contact.name });
    }
  }

  // Weaker: the same company QC campaigned into, but nobody on the deal ties back to a specific person.
  // Flagged for review, never counted as certain — two companies can share a name or a domain, and the
  // client may have known someone else there. But it is surfaced rather than hidden, because a deal at a
  // company QC worked is worth a human's eyes even when the person does not line up.
  const byDomain = qc?.byDomain ?? new Map();
  const domain = normalizeDomain(deal?.companyDomain);
  if (domain && (byDomain.has(domain) || domains.has(domain))) {
    const info = byDomain.get(domain) ?? { campaign: "", companyLogo: "" };
    return {
      attribution: "possible", matchedBy: "domain", campaign: info.campaign || "",
      reason: `${deal?.companyName || domain} is a company QC campaigned into${info.campaign ? ` (${info.campaign})` : ""}, but no specific person on this deal matched — worth a look.`,
      evidence: { domain }, leadId: info.leadId || "", companyLogo: info.companyLogo || "",
    };
  }

  for (const [key, list] of byCompany) {
    if (companyMatches(dealCompany, key)) {
      const info = list[0];
      return {
        attribution: "possible", matchedBy: "company", campaign: info.campaign || "",
        reason: `${deal?.companyName} matches a company QC campaigned into${info.campaign ? ` (${info.campaign})` : ""} — confirm the person to count it.`,
        evidence: { company: key }, leadId: info.leadId || "", companyLogo: info.companyLogo || "",
      };
    }
  }

  return { attribution: "none", matchedBy: null, campaign: "", reason: "", evidence: {}, leadId: "", companyLogo: "" };
}
