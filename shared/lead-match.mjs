// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Who an email lead is on LinkedIn. Every email campaign is fed from a HeyReach campaign (LinkedIn first,
 * then the lead drips into Email Bison), so the person replying by email is almost always a lead QC already
 * holds with a LinkedIn profile. These are the pure comparisons the matcher in app/lib/email-ingest.ts uses;
 * tests/lead-match.test.mjs drives them with real name and company shapes.
 */

const CREDENTIALS = /\b(mba|phd|md|do|rn|cpa|cfa|pmp|jd|msc|bsc|ma|ms|bs|mph|dnp|np|pa-c|faap|facp|cissp|shrm-cp|sphr)\b\.?/gi;

/** A name reduced to comparable words: accents, emoji, credentials, nicknames in brackets and punctuation gone. */
export function normalName(name) {
  return String(name ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\(\[\{"“][^\)\]\}"”]*[\)\]\}"”]/g, " ") // "(Bob)", "[she/her]"
    .split(",")[0] // "Megan Kolbe, MBA"
    .replace(CREDENTIALS, " ")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/[-']/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/** First and last word of a name, which is what two spellings of one person reliably share. */
export function nameKey(name) {
  const words = normalName(name).split(" ").filter(Boolean);
  if (!words.length) return "";
  return words.length === 1 ? words[0] : `${words[0]} ${words[words.length - 1]}`;
}

const COMPANY_NOISE = new Set(["inc", "llc", "ltd", "limited", "corp", "corporation", "co", "company", "gmbh", "plc", "the", "group", "holdings", "hq", "ai", "io"]);

/** A company's distinctive words: "KURU Footwear, Inc." → ["kuru", "footwear"]. */
export function companyWords(company) {
  return String(company ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1 && !COMPANY_NOISE.has(word));
}

/** Whether two company names are the same company: one's distinctive words contain the other's first word. */
export function sameCompany(a, b) {
  const left = companyWords(a);
  const right = companyWords(b);
  if (!left.length || !right.length) return false;
  return right.includes(left[0]) || left.includes(right[0]);
}

/**
 * The one candidate (LinkedIn leads in the same client) this email person is, or null.
 * Same first and last name is required. With several, the one at the same company wins; a lone name match
 * is accepted when it is the only person of that name in the client, since the email list came from
 * the same LinkedIn list. Two people of the same name and no company to tell them apart returns null.
 * @param {{ name: string, company?: string }} person
 * @param {Array<{ id: string, name: string, company?: string }>} candidates
 */
export function pickLinkedInLead(person, candidates) {
  const key = nameKey(person.name);
  if (!key || !key.includes(" ")) return null;
  const sameName = (Array.isArray(candidates) ? candidates : []).filter((row) => nameKey(row.name) === key);
  if (sameName.length === 1) return sameName[0];
  const atCompany = sameName.filter((row) => sameCompany(person.company, row.company));
  return atCompany.length === 1 ? atCompany[0] : null;
}

/** A LinkedIn profile handle from any of an Email Bison lead's custom variables, or "". */
export function linkedinFromVariables(variables) {
  for (const variable of Array.isArray(variables) ? variables : []) {
    const match = String(variable?.value ?? "").match(/linkedin\.com\/in\/([^/?#\s]+)/i);
    if (match) return decodeURIComponent(match[1]).toLowerCase();
  }
  return "";
}
