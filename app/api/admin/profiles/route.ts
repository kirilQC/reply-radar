import { NextResponse } from "next/server";

const config = () => ({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY });
const headers = (key: string) => ({ apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" });

export async function GET() {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const h = headers(key);
  let profilesResponse = await fetch(`${url}/rest/v1/rr_profiles?select=id,name,avatar_url,created_at,updated_at&order=created_at.asc`, { headers: h, cache: "no-store" });
  // Existing projects may predate avatar_url. Keep profile/name management live
  // while the additive migration is pending; photos can be enabled by running it.
  let profilesIncludePhoto = profilesResponse.ok;
  if (!profilesResponse.ok) {
    profilesResponse = await fetch(`${url}/rest/v1/rr_profiles?select=id,name,created_at,updated_at&order=created_at.asc`, { headers: h, cache: "no-store" });
    profilesIncludePhoto = false;
  }
  const [linksResponse, workspacesResponse] = await Promise.all([
    fetch(`${url}/rest/v1/rr_profile_workspaces?select=profile_id,workspace_id`, { headers: h, cache: "no-store" }),
    fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug`, { headers: h, cache: "no-store" }),
  ]);
  const profiles = await profilesResponse.json(); const links = await linksResponse.json(); const workspaces = await workspacesResponse.json();
  if (!profilesResponse.ok) return NextResponse.json({ ok: false, error: JSON.stringify(profiles) }, { status: profilesResponse.status });
  const workspaceById = new Map((Array.isArray(workspaces) ? workspaces : []).map((item: { id: string; name: string; slug: string }) => [item.id, item]));
  const byProfile = new Map<string, string[]>();
  for (const link of Array.isArray(links) ? links : []) { const workspace = workspaceById.get(link.workspace_id); if (workspace) byProfile.set(link.profile_id, [...(byProfile.get(link.profile_id) ?? []), workspace.name || workspace.slug]); }
  return NextResponse.json({ ok: true, photoColumnAvailable: profilesIncludePhoto, profiles: (Array.isArray(profiles) ? profiles : []).map((item: { id: string; name: string; avatar_url?: string; created_at: string }) => ({ slug: item.id, name: item.name, photo: item.avatar_url ?? null, role: "Teammate", clients: byProfile.get(item.id) ?? [], createdAt: item.created_at })) });
}

export async function POST(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json();
  // Only pass database UUIDs through to PATCH. Older browser caches used
  // human-readable slugs; treating those as new records avoids a silent
  // 22P02 UUID error and makes profile edits persist after a cache refresh.
  const id = typeof payload.id === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(payload.id) ? payload.id : undefined;
  const profile = { ...(id ? { id } : {}), name: String(payload.name ?? ""), avatar_url: payload.photo || null };
  let photoColumnAvailable = true;
  let saved = await fetch(`${url}/rest/v1/rr_profiles${id ? `?id=eq.${encodeURIComponent(id)}` : ""}`, { method: id ? "PATCH" : "POST", headers: { ...headers(key), Prefer: "return=representation" }, body: JSON.stringify(profile) });
  if (!saved.ok) {
    const errorText = await saved.clone().text();
    if (/avatar_url|PGRST204|schema cache/i.test(errorText)) {
      photoColumnAvailable = false;
      const legacyProfile = { ...(id ? { id } : {}), name: profile.name };
      saved = await fetch(`${url}/rest/v1/rr_profiles${id ? `?id=eq.${encodeURIComponent(id)}` : ""}`, { method: id ? "PATCH" : "POST", headers: { ...headers(key), Prefer: "return=representation" }, body: JSON.stringify(legacyProfile) });
    }
  }
  const rows = await saved.json().catch(() => []);
  if (!saved.ok) return NextResponse.json({ ok: false, error: JSON.stringify(rows) }, { status: saved.status });
  const savedProfile = Array.isArray(rows) ? rows[0] : rows;
  const profileId = savedProfile?.id ?? id;
  if (profileId) {
    await fetch(`${url}/rest/v1/rr_profile_workspaces?profile_id=eq.${encodeURIComponent(profileId)}`, { method: "DELETE", headers: { ...headers(key), Prefer: "return=minimal" } });
    const workspaceRows = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug`, { headers: headers(key), cache: "no-store" }).then((r) => r.json()).catch(() => []);
    const wanted = new Set(Array.isArray(payload.clients) ? payload.clients : []);
    const links = (Array.isArray(workspaceRows) ? workspaceRows : []).filter((item: { name: string; slug: string }) => wanted.has(item.name) || wanted.has(item.slug)).map((item: { id: string }) => ({ profile_id: profileId, workspace_id: item.id }));
    if (links.length) {
      const linkResponse = await fetch(`${url}/rest/v1/rr_profile_workspaces`, { method: "POST", headers: { ...headers(key), Prefer: "return=minimal" }, body: JSON.stringify(links) });
      if (!linkResponse.ok) return NextResponse.json({ ok: false, error: await linkResponse.text() }, { status: linkResponse.status });
    }
  }
  return NextResponse.json({ ok: true, profile: savedProfile, photoColumnAvailable }, { status: 200 });
}

export async function DELETE(request: Request) {
  const { url, key } = config();
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const payload = await request.json().catch(() => ({})); const id = String(payload.id ?? "");
  if (!id) return NextResponse.json({ ok: false, error: "Profile id is required." }, { status: 400 });
  const response = await fetch(`${url}/rest/v1/rr_profiles?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: { ...headers(key), Prefer: "return=representation" } });
  const rows = await response.json().catch(() => []);
  return NextResponse.json({ ok: response.ok && Array.isArray(rows) && rows.length > 0, deletedCount: Array.isArray(rows) ? rows.length : 0, error: response.ok ? undefined : JSON.stringify(rows) }, { status: response.ok ? 200 : response.status });
}
