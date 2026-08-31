// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Set a workspace's client logo during onboarding — upload an image file (stored in a public bucket) or
// paste a URL. Either way it lands in rr_workspaces.logo_url, which every client badge across the app reads.
import { NextResponse } from "next/server";

const BUCKET = "reply-radar-logos";

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  const auth = { apikey: key, Authorization: `Bearer ${key}` };

  let slug = "";
  let logoUrl = "";
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    slug = String(form.get("slug") ?? "").trim();
    const file = form.get("file");
    if (!slug) return NextResponse.json({ ok: false, error: "slug required" }, { status: 400 });
    if (file instanceof File && file.size > 0) {
      if (file.size > 5_000_000) return NextResponse.json({ ok: false, error: "Image is over 5MB — please use a smaller file." }, { status: 400 });
      // Make sure the bucket exists (public), then upsert the file.
      await fetch(`${url}/storage/v1/bucket`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 5_242_880 }) }).catch(() => {});
      const type = file.type || "image/png";
      const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("svg") ? "svg" : type.includes("gif") ? "gif" : "jpg";
      const path = `${slug}/logo.${ext}`;
      const uploaded = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, { method: "POST", headers: { ...auth, "content-type": type, "x-upsert": "true" }, body: await file.arrayBuffer() });
      if (!uploaded.ok) return NextResponse.json({ ok: false, error: `Upload failed (${uploaded.status}).` }, { status: 502 });
      // Cache-bust so a re-upload shows immediately.
      logoUrl = `${url}/storage/v1/object/public/${BUCKET}/${path}?v=${Math.floor(Date.now() / 1000)}`;
    }
  } else {
    const body = await request.json().catch(() => ({}));
    slug = String(body.slug ?? "").trim();
    logoUrl = String(body.logoUrl ?? "").trim();
    if (logoUrl && !/^https?:\/\//i.test(logoUrl) && !logoUrl.startsWith("/")) logoUrl = `https://${logoUrl}`;
  }

  if (!slug) return NextResponse.json({ ok: false, error: "slug required" }, { status: 400 });
  if (!logoUrl) return NextResponse.json({ ok: false, error: "No image or URL provided." }, { status: 400 });

  const patch = await fetch(`${url}/rest/v1/rr_workspaces?slug=eq.${encodeURIComponent(slug)}`, {
    method: "PATCH", headers: { ...auth, "content-type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ logo_url: logoUrl }),
  });
  if (!patch.ok) return NextResponse.json({ ok: false, error: `Could not save the logo (${patch.status}).` }, { status: 502 });
  return NextResponse.json({ ok: true, logoUrl });
}
