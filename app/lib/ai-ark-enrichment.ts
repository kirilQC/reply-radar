// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;
type SupabaseConfig = { url: string; key: string };

// Overridable for a proxy or a test double; AI Ark itself is the default.
const API_BASE = (process.env.AI_ARK_BASE_URL || "https://api.ai-ark.com").replace(/\/+$/, "");
const ENDPOINT = `${API_BASE}/api/developer-portal/v1/people`;
// Phone numbers are NOT part of People Search — AI Ark reveals a mobile through a separate finder endpoint,
// billed 5 credits only when a number is found. Takes a LinkedIn URL; the number is at data.data[0][0].
const PHONE_ENDPOINT = `${API_BASE}/api/developer-portal/v2/people/mobile-phone-finder`;
const BUCKET = "reply-radar-enrichment";
const object = (value: unknown): JsonObject =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const normalize = (value: unknown) =>
  text(value).toLowerCase().replace(/\s+/g, " ");
export const normalizeLinkedIn = (value: unknown) => {
  const candidate = text(value);
  if (!candidate) return "";
  try {
    const url = new URL(
      candidate.startsWith("http") ? candidate : `https://${candidate}`,
    );
    return `${url.hostname.replace(/^www\./, "").toLowerCase()}${url.pathname.replace(/\/+$/, "").toLowerCase()}`;
  } catch {
    return candidate
      .toLowerCase()
      .replace(/^https?:\/\/(www\.)?/, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "");
  }
};
export const personLinkedIn = (value: unknown) => {
  const person = object(value);
  return (
    text(object(person.link).linkedin) ||
    text(object(object(person.profile).link).linkedin) ||
    text(person.linkedin_url) ||
    text(person.linkedin)
  );
};

/**
 * Find a person's mobile phone from their LinkedIn URL, via AI Ark's Mobile Phone Finder.
 *
 * Separate from People Search and billed per hit (5 credits when found, 0 otherwise), so it is only called
 * where a number is actually wanted — the cold-calling fetch. Returns the number (e.g. "+13152468945") or
 * null. Best effort: no key, no match, or an error all return null rather than throwing.
 */
export async function findMobilePhone(profileUrl: string): Promise<string | null> {
  const apiKey = text(process.env.AI_ARK_API_KEY);
  const linkedin = text(profileUrl);
  if (!apiKey || !linkedin) return null;
  try {
    const response = await fetch(PHONE_ENDPOINT, {
      method: "POST",
      headers: { "X-TOKEN": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ linkedin }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return null;
    const body = object(await response.json().catch(() => ({})));
    const data = object(body.data);
    // Numbers arrive nested: data.data is an array of arrays, e.g. [["+1315..."]].
    const groups = list(data.data);
    const first = list(groups[0]);
    const phone = text(first[0]);
    return phone || null;
  } catch {
    return null;
  }
}

/**
 * Up to 100 people in one People Search call, matched back to the URLs asked for.
 *
 * Built for the Jev pipeline, where a list of thousands would otherwise be thousands of calls against AI Ark's
 * default limit of 5 requests a second. `socialMediaLink.any.include` is an OR over the URLs; each result is
 * matched to its URL by the same normalisation `selectAiArkPerson` uses, so a near-namesake can never be
 * attached to the wrong row. Billed 0.5 credits per result returned — URLs AI Ark does not know cost nothing.
 */
export async function lookupPeople(profileUrls: string[]): Promise<{ ok: boolean; people: Map<string, JsonObject>; error?: string; rateLimited?: boolean }> {
  const apiKey = text(process.env.AI_ARK_API_KEY);
  const people = new Map<string, JsonObject>();
  if (!apiKey) return { ok: false, people, error: "AI_ARK_API_KEY is not set." };
  const urls = [...new Set(profileUrls.map(text).filter(Boolean))].slice(0, 100);
  if (!urls.length) return { ok: true, people };
  let last = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "X-TOKEN": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ contact: { socialMediaLink: { any: { include: urls } } }, page: 0, size: urls.length }),
        signal: AbortSignal.timeout(30_000),
      });
      const data = object(await response.json().catch(() => ({})));
      if (response.ok) {
        const wanted = new Set(urls.map(normalizeLinkedIn));
        for (const candidate of list(data.content)) {
          const key = normalizeLinkedIn(personLinkedIn(candidate));
          if (key && wanted.has(key) && !people.has(key)) people.set(key, object(candidate));
        }
        return { ok: true, people };
      }
      last = `AI Ark People Search failed (${response.status}): ${JSON.stringify(data).slice(0, 300)}`;
      if (response.status === 429) { await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt)); continue; }
      if (response.status < 500) break;
    } catch (error) {
      last = error instanceof Error ? error.message : "Could not reach AI Ark.";
    }
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
  return { ok: false, people, error: last || "AI Ark did not answer.", rateLimited: /\(429\)/.test(last) };
}

export function selectAiArkPerson(
  responseValue: unknown,
  expectedProfileUrl: string,
) {
  const response = object(responseValue);
  const candidates = Array.isArray(response.content)
    ? response.content
    : [responseValue];
  const populated = candidates.filter(
    (candidate) => Object.keys(object(candidate)).length > 0,
  );
  const expected = normalizeLinkedIn(expectedProfileUrl);
  if (!expected) return populated[0] ?? null;
  return (
    populated.find(
      (candidate) => normalizeLinkedIn(personLinkedIn(candidate)) === expected,
    ) ?? null
  );
}

export function extractAiArkEnrichment(
  personValue: unknown,
  leadCompany: string,
) {
  const person = object(personValue);
  const profile = object(person.profile);
  const picture = object(profile.picture);
  const background = object(profile.background);
  const companyName = normalize(leadCompany);
  const groups = list(person.position_groups).map(object);
  const companies = groups.map((group) => object(group.company));
  const matchedCompany =
    companies.find(
      (company) => companyName && normalize(company.name) === companyName,
    ) ??
    companies.find((company) => {
      const candidate = normalize(company.name);
      return (
        companyName &&
        candidate &&
        (candidate.includes(companyName) || companyName.includes(candidate))
      );
    }) ??
    object(person.company);
  const topCompanySummary = object(object(person.company).summary);
  const companyLogo =
    text(matchedCompany.logo) ||
    text(object(matchedCompany.logo).source) ||
    text(topCompanySummary.logo) ||
    text(object(topCompanySummary.logo).source);
  return {
    schemaVersion: 2,
    provider: "ai_ark",
    providerPersonId: person.id ?? person.identifier ?? null,
    profileLinkedInUrl: personLinkedIn(person) || null,
    enrichedAt: new Date().toISOString(),
    profilePhotoSource: text(picture.source) || null,
    profilePhotoUrl: text(picture.source) || null,
    backgroundPhotoUrl: text(background.source) || null,
    companyPhotoSource: companyLogo || null,
    companyPhotoUrl: companyLogo || null,
    headline: text(profile.headline) || null,
    title: text(profile.title) || null,
    summary: text(profile.summary) || null,
    birthDate: profile.birth_date ?? null,
    location: person.location ?? null,
    industry: person.industry ?? null,
    languages: person.languages ?? [],
    skills: person.skills ?? [],
    educations: person.educations ?? [],
    certifications: person.certifications ?? [],
    organizations: person.organizations ?? [],
    positionGroups: person.position_groups ?? [],
    links: person.link ?? {},
    company: person.company ?? matchedCompany,
    department: person.department ?? {},
    statistics: person.statistics ?? {},
    memberBadges: person.member_badges ?? {},
    lastUpdated: person.last_updated ?? null,
    raw: person,
  };
}

async function audit(config: SupabaseConfig, path: string, init: RequestInit) {
  const response = await fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  const body = await response.text();
  if (!response.ok)
    throw new Error(
      `AI Ark audit write failed (${response.status}): ${body.slice(0, 500)}`,
    );
  return body ? JSON.parse(body) : null;
}

async function persistImage(
  config: SupabaseConfig,
  source: string,
  workspaceId: string,
  profileUrl: string,
  kind: "profile" | "company",
) {
  if (!source) return null;
  try {
    await fetch(`${config.url}/storage/v1/bucket`, {
      method: "POST",
      headers: {
        apikey: config.key,
        Authorization: `Bearer ${config.key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: BUCKET,
        name: BUCKET,
        public: true,
        file_size_limit: 10_485_760,
      }),
    });
    const image = await fetch(source, { signal: AbortSignal.timeout(15_000) });
    if (!image.ok) return null;
    const contentType =
      image.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const extension = contentType.includes("png")
      ? "png"
      : contentType.includes("webp")
        ? "webp"
        : "jpg";
    const hash = createHash("sha256")
      .update(`${workspaceId}|${profileUrl}|${kind}`)
      .digest("hex");
    const path = `${workspaceId}/${hash}-${kind}.${extension}`;
    const uploaded = await fetch(
      `${config.url}/storage/v1/object/${BUCKET}/${path}`,
      {
        method: "POST",
        headers: {
          apikey: config.key,
          Authorization: `Bearer ${config.key}`,
          "content-type": contentType,
          "x-upsert": "true",
        },
        body: await image.arrayBuffer(),
      },
    );
    if (!uploaded.ok) return null;
    return `${config.url}/storage/v1/object/public/${BUCKET}/${path}`;
  } catch {
    return null;
  }
}

/**
 * A person by their email address (AI Ark's reverse lookup), for an email lead QC has no LinkedIn for. Returns
 * the matched profile URL, or "" when AI Ark does not know the address. Never throws.
 */
export async function linkedinByEmail(email: string): Promise<string> {
  const apiKey = text(process.env.AI_ARK_API_KEY);
  const address = text(email).toLowerCase();
  if (!apiKey || !address.includes("@")) return "";
  try {
    const response = await fetch(`${API_BASE}/api/developer-portal/v1/people/reverse-lookup`, {
      method: "POST",
      headers: { "X-TOKEN": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "CONTACT", search: address, page: 0, size: 3 }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return "";
    const data = object(await response.json().catch(() => ({})));
    for (const candidate of list(data.content ?? data.data)) {
      const url = personLinkedIn(candidate);
      if (url) return url;
    }
  } catch {
    /* unknown address or AI Ark unreachable: the lead stays email-only */
  }
  return "";
}

export async function enrichLeadWithAiArk(
  config: SupabaseConfig,
  workspaceId: string,
  profileUrl: string,
  companyName: string,
) {
  const apiKey = text(process.env.AI_ARK_API_KEY);
  if (!apiKey)
    throw new Error(
      "AI Ark enrichment is enabled, but AI_ARK_API_KEY is not configured.",
    );
  // One sync-run row per lead enrichment call. Retries stay internal so the
  // health check reflects real service outcomes (`success`, `no_match`, `failed`)
  // rather than counting every transient retry as its own failure.
  const startedAt = new Date().toISOString();
  const runRows = (await audit(config, "rr_sync_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      workspace_id: workspaceId,
      source: "ai_ark",
      run_type: "lead_enrichment",
      status: "running",
      started_at: startedAt,
      records_seen: 1,
      records_written: 0,
    }),
  })) as JsonObject[];
  const runId = text(runRows?.[0]?.id);
  const markRun = async (fields: JsonObject) => {
    if (!runId) return;
    await audit(config, `rr_sync_runs?id=eq.${encodeURIComponent(runId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ finished_at: new Date().toISOString(), ...fields }),
    }).catch(() => null);
  };

  // Distinguishes "AI Ark doesn't have this person" (a data condition, not a
  // service failure) from real API errors. `no_match` bails out immediately
  // because retrying won't create a record that doesn't exist.
  class AiArkNoMatchError extends Error {}

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "X-TOKEN": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          contact: { socialMediaLink: { any: { include: [profileUrl] } } },
          page: 0,
          size: 10,
        }),
        signal: AbortSignal.timeout(4_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          `AI Ark People Search failed (${response.status}): ${JSON.stringify(data).slice(0, 1_000)}`,
        );
      const person = selectAiArkPerson(data, profileUrl);
      if (!person)
        throw new AiArkNoMatchError(
          "AI Ark has no record matching this lead's LinkedIn profile URL.",
        );
      const enrichment = extractAiArkEnrichment(person, companyName);
      const [profilePhotoUrl, companyPhotoUrl] = await Promise.all([
        persistImage(config, text(enrichment.profilePhotoSource), workspaceId, profileUrl, "profile"),
        persistImage(config, text(enrichment.companyPhotoSource), workspaceId, profileUrl, "company"),
      ]);
      const result = {
        ...enrichment,
        profilePhotoUrl: profilePhotoUrl || enrichment.profilePhotoUrl,
        companyPhotoUrl: companyPhotoUrl || enrichment.companyPhotoUrl,
      };
      await markRun({ status: "success", records_written: 1 });
      return result;
    } catch (error) {
      lastError = error;
      // No-match is a data condition and never retries.
      if (error instanceof AiArkNoMatchError) break;
      if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, attempt * 150));
    }
  }

  if (lastError instanceof AiArkNoMatchError) {
    await markRun({ status: "no_match", error_text: lastError.message.slice(0, 2_000) });
    throw lastError;
  }
  const message = lastError instanceof Error ? lastError.message : "AI Ark enrichment failed after five attempts.";
  await markRun({ status: "failed", error_text: message.slice(0, 2_000) });
  throw lastError instanceof Error ? lastError : new Error(message);
}

/* ── Email finder, for QC Bot / Scout "find this person's email" ─────────────────────────────────── */

const EXPORT_SINGLE_ENDPOINT = `${API_BASE}/api/developer-portal/v2/people/export/single`;

export type EmailLookup = {
  asked: string;
  found: boolean;
  name?: string; title?: string; company?: string; companyDomain?: string; location?: string; linkedin?: string;
  email?: string; emailStatus?: string; emailType?: string; otherEmails?: string[];
  phone?: string | null;
  note?: string;
};

/** The person's details out of an AI Ark person record (People Search and Export share the shape). */
function personSummary(person: JsonObject) {
  const profile = object(person.profile);
  const company = object(person.company);
  const summary = object(company.summary);
  const link = object(company.link);
  const firstGroup = object(list(person.position_groups)[0]);
  return {
    name: text(profile.full_name) || [text(profile.first_name), text(profile.last_name)].filter(Boolean).join(" "),
    title: text(profile.title) || text(object(list(firstGroup.profile_positions)[0]).title),
    company: text(summary.name) || text(object(firstGroup.company).name),
    companyDomain: text(link.domain),
    location: text(object(person.location).default),
    linkedin: personLinkedIn(person),
  };
}

async function exportSingle(apiKey: string, body: JsonObject): Promise<{ person: JsonObject | null; error?: string }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(EXPORT_SINGLE_ENDPOINT, {
      method: "POST",
      headers: { "X-TOKEN": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    }).catch((error: unknown) => ({ ok: false, status: 0, json: async () => ({ error: String(error) }) }) as unknown as Response);
    const data = object(await response.json().catch(() => ({})));
    if (response.status === 429) { await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt)); continue; }
    if (!response.ok) return { person: null, error: `AI Ark export failed (${response.status}): ${JSON.stringify(data).slice(0, 200)}` };
    const person = data.data && typeof data.data === "object" ? object(data.data) : null;
    return { person, error: person ? undefined : text(data.error) || undefined };
  }
  return { person: null, error: "AI Ark rate limit; try again in a minute." };
}

/** People Search by name plus employer, for "find the email of Jane Doe at Acme". Best match only. */
async function searchByName(apiKey: string, name: string, company: string, domain: string, title: string): Promise<JsonObject | null> {
  const contact: JsonObject = { fullName: { any: { include: { mode: "SMART", content: [name] } } } };
  if (title) contact.experience = { current: { title: { any: { include: { mode: "SMART", content: [title] } } } } };
  const account: JsonObject = {};
  if (domain) account.domain = { any: { include: [domain.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")] } };
  else if (company) account.name = { any: { include: { mode: "SMART", content: [company] } } };
  const body: JsonObject = { contact, page: 0, size: 5 };
  if (Object.keys(account).length) body.account = account;
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "X-TOKEN": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`AI Ark People Search failed (${response.status}): ${(await response.text().catch(() => "")).slice(0, 200)}`);
  const data = object(await response.json().catch(() => ({})));
  const wanted = normalize(name);
  const candidates = list(data.content).map(object);
  return candidates.find((c) => normalize(personSummary(c).name) === wanted) ?? candidates[0] ?? null;
}

/**
 * Emails (and optionally mobiles) for a handful of people, each given as a LinkedIn URL or as a name plus company.
 * 1 credit per email found (0 when none), +5 per mobile found when phones are asked for.
 */
export async function findEmails(people: Array<{ linkedin?: string; name?: string; company?: string; domain?: string; title?: string }>, withPhone = false): Promise<EmailLookup[]> {
  const apiKey = text(process.env.AI_ARK_API_KEY);
  if (!apiKey) throw new Error("AI Ark isn't connected (AI_ARK_API_KEY is not set).");
  const out: EmailLookup[] = [];
  for (const p of people.slice(0, 10)) {
    const linkedin = text(p.linkedin);
    const asked = linkedin || [text(p.name), text(p.title), text(p.company) || text(p.domain)].filter(Boolean).join(", ");
    try {
      let body: JsonObject | null = null;
      let fromSearch: JsonObject | null = null;
      if (linkedin) body = { url: linkedin.startsWith("http") ? linkedin : `https://${linkedin}` };
      else if (text(p.name)) {
        fromSearch = await searchByName(apiKey, text(p.name), text(p.company), text(p.domain), text(p.title));
        if (!fromSearch) { out.push({ asked, found: false, note: "No one by that name at that company in AI Ark." }); continue; }
        body = { id: text(fromSearch.id) };
      } else { out.push({ asked, found: false, note: "Needs a LinkedIn URL, or a name plus company." }); continue; }
      const { person, error } = await exportSingle(apiKey, body);
      const record = person ?? fromSearch;
      const info = record ? personSummary(record) : {};
      const emails = list(object(object(person ?? {}).email).output).map(object).filter((e) => text(e.address));
      const best = emails.find((e) => text(e.status).toUpperCase() === "VALID") ?? emails[0];
      const phone = withPhone && (info as { linkedin?: string }).linkedin ? await findMobilePhone(String((info as { linkedin?: string }).linkedin)) : undefined;
      out.push({
        asked, found: Boolean(best), ...info,
        ...(best ? { email: text(best.address), emailStatus: text(best.status) || undefined, emailType: text(best.domainType) === "CATCH_ALL" ? "catch-all domain (may bounce)" : text(best.domainType) || undefined } : {}),
        ...(emails.length > 1 ? { otherEmails: emails.slice(1).map((e) => text(e.address)) } : {}),
        ...(withPhone ? { phone: phone ?? null } : {}),
        ...(best ? {} : { note: error || (record ? "Found the person but AI Ark has no verified email for them." : "Not in AI Ark.") }),
      });
    } catch (error) {
      out.push({ asked, found: false, note: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}
