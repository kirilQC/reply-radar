const KNOWN_CREDENTIALS = new Set(
  [
    "CISSP", "CISA", "CPA", "PHD", "MD", "MBA", "PMP", "CSM", "CISM",
    "ITIL", "RN", "BS", "MS", "MSN", "BSN", "FACHE", "MPH", "CCSP",
    "CFA", "CFP", "PE", "P.E", "DDS", "DMD", "DO", "JD", "ESQ", "SHRMCP",
    "SHRMSCP", "SPHR", "PHR", "CRISC", "GIAC", "CFE", "CIA", "CMA", "CA",
  ].map((value) => value.replace(/[^A-Z0-9]/g, "")),
);

const credentialKey = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "");
const looksLikeCredential = (value: string, allowUnknown = false) => {
  const key = credentialKey(value);
  if (!key) return false;
  if (KNOWN_CREDENTIALS.has(key)) return true;
  return allowUnknown && /^[A-Z][A-Z0-9]{1,9}$/.test(key) && value === value.toUpperCase();
};

const titleCase = (value: string) =>
  value
    .toLocaleLowerCase("en-US")
    .replace(/(^|[\s'’-])\p{L}/gu, (match) => match.toLocaleUpperCase("en-US"));

export function normalizePersonName(value: unknown) {
  let name = typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!name) return "Unknown lead";
  name = name
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  const commaParts = name.split(",").map((part) => part.trim()).filter(Boolean);
  if (commaParts.length > 1) {
    // Generic all-caps suffixes are only stripped after a comma. That boundary
    // prevents a legitimate upper-case surname from being mistaken for a title.
    while (commaParts.length > 1 && looksLikeCredential(commaParts.at(-1)!, true)) commaParts.pop();
    name = commaParts.join(", ");
  }
  name = name.replace(/\s*\(([^)]+)\)\s*$/u, (full, suffix: string) =>
    looksLikeCredential(suffix, true) ? "" : full,
  );
  const words = name.split(/\s+/).filter(Boolean);
  while (words.length > 2 && looksLikeCredential(words.at(-1)!)) words.pop();
  name = words.join(" ").replace(/\s+,/g, ",").trim();

  const letters = name.replace(/[^\p{L}]/gu, "");
  if (letters && (letters === letters.toUpperCase() || letters === letters.toLowerCase())) {
    name = titleCase(name);
  }
  return name || "Unknown lead";
}
