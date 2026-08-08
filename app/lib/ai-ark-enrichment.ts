import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;
type SupabaseConfig = { url: string; key: string };

const ENDPOINT = "https://api.ai-ark.com/api/developer-portal/v1/people";
const BUCKET = "reply-radar-enrichment";
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const list = (value: unknown) => Array.isArray(value) ? value : [];
const normalize = (value: unknown) => text(value).toLowerCase().replace(/\s+/g, " ");

export function extractAiArkEnrichment(personValue: unknown, leadCompany: string) {
  const person = object(personValue);
  const profile = object(person.profile);
  const picture = object(profile.picture);
  const background = object(profile.background);
  const companyName = normalize(leadCompany);
  const groups = list(person.position_groups).map(object);
  const companies = groups.map((group) => object(group.company));
  const matchedCompany = companies.find((company) => companyName && normalize(company.name) === companyName)
    ?? companies.find((company) => {
      const candidate = normalize(company.name);
      return companyName && candidate && (candidate.includes(companyName) || companyName.includes(candidate));
    })
    ?? object(person.company);
  const topCompanySummary = object(object(person.company).summary);
  const companyLogo = text(matchedCompany.logo) || text(object(matchedCompany.logo).source) || text(topCompanySummary.logo) || text(object(topCompanySummary.logo).source);
  return {
    provider: "ai_ark",
    providerPersonId: person.id ?? person.identifier ?? null,
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
    headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json", ...(init.headers ?? {}) },
    cache: "no-store",
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`AI Ark audit write failed (${response.status}): ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : null;
}

async function persistImage(config: SupabaseConfig, source: string, workspaceId: string, profileUrl: string, kind: "profile" | "company") {
  if (!source) return null;
  try {
    await fetch(`${config.url}/storage/v1/bucket`, {
      method: "POST",
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": "application/json" },
      body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 10_485_760 }),
    });
    const image = await fetch(source, { signal: AbortSignal.timeout(15_000) });
    if (!image.ok) return null;
    const contentType = image.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    const extension = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const hash = createHash("sha256").update(`${workspaceId}|${profileUrl}|${kind}`).digest("hex");
    const path = `${workspaceId}/${hash}-${kind}.${extension}`;
    const uploaded = await fetch(`${config.url}/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST",
      headers: { apikey: config.key, Authorization: `Bearer ${config.key}`, "content-type": contentType, "x-upsert": "true" },
      body: await image.arrayBuffer(),
    });
    if (!uploaded.ok) return null;
    return `${config.url}/storage/v1/object/public/${BUCKET}/${path}`;
  } catch { return null; }
}

export async function enrichLeadWithAiArk(config: SupabaseConfig, workspaceId: string, profileUrl: string, companyName: string) {
  const apiKey = text(process.env.AI_ARK_API_KEY);
  if (!apiKey) throw new Error("AI Ark enrichment is enabled, but AI_ARK_API_KEY is not configured.");
  const startedAt = new Date().toISOString();
  const rows = await audit(config, "rr_sync_runs", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ workspace_id: workspaceId, source: "ai_ark", run_type: "lead_enrichment", status: "running", started_at: startedAt, records_seen: 1, records_written: 0 }),
  }) as JsonObject[];
  const runId = text(rows?.[0]?.id);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "X-TOKEN": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ contact: { socialMediaLink: { any: { include: [profileUrl] } } }, page: 0, size: 10 }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`AI Ark People Search failed (${response.status}): ${JSON.stringify(data).slice(0, 1_000)}`);
    const person = Array.isArray(object(data).content) ? (object(data).content as unknown[])[0] : data;
    if (!person || !Object.keys(object(person)).length) throw new Error("AI Ark returned no matching person for this LinkedIn profile.");
    const enrichment = extractAiArkEnrichment(person, companyName);
    const [profilePhotoUrl, companyPhotoUrl] = await Promise.all([
      persistImage(config, text(enrichment.profilePhotoSource), workspaceId, profileUrl, "profile"),
      persistImage(config, text(enrichment.companyPhotoSource), workspaceId, profileUrl, "company"),
    ]);
    const result = { ...enrichment, profilePhotoUrl: profilePhotoUrl || enrichment.profilePhotoUrl, companyPhotoUrl: companyPhotoUrl || enrichment.companyPhotoUrl };
    if (runId) await audit(config, `rr_sync_runs?id=eq.${encodeURIComponent(runId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "success", finished_at: new Date().toISOString(), records_written: 1 }) });
    return result;
  } catch (error) {
    if (runId) await audit(config, `rr_sync_runs?id=eq.${encodeURIComponent(runId)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", finished_at: new Date().toISOString(), error_text: error instanceof Error ? error.message.slice(0, 2_000) : "AI Ark enrichment failed" }) }).catch(() => null);
    throw error;
  }
}
