// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Upload an image for a custom view logo — stored in a public bucket; returns its URL for the view record.
import { NextResponse } from "next/server";
const BUCKET = "reply-radar-logos";
export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  const auth = { apikey: key, Authorization: `Bearer ${key}` };
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "No file." }, { status: 400 });
  if (file.size > 5_000_000) return NextResponse.json({ ok: false, error: "Image over 5MB." }, { status: 400 });
  await fetch(`${url}/storage/v1/bucket`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 5_242_880 }) }).catch(() => {});
  const type = file.type || "image/png";
  const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("svg") ? "svg" : type.includes("gif") ? "gif" : "jpg";
  const path = `views/${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}.${ext}`;
  const up = await fetch(`${url}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, { method: "POST", headers: { ...auth, "content-type": type, "x-upsert": "true" }, body: await file.arrayBuffer() });
  if (!up.ok) return NextResponse.json({ ok: false, error: `Upload failed (${up.status}).` }, { status: 502 });
  return NextResponse.json({ ok: true, logoUrl: `${url}/storage/v1/object/public/${BUCKET}/${path}` });
}
