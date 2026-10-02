// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * A file attached to a task's notes: stored in the pm-files Storage bucket and returned as a public URL
 * the notes link to. The path is random, so a file is only reachable from the note that links it.
 */

import { NextResponse } from "next/server";

const BUCKET = "pm-files";
const MAX_BYTES = 4_000_000; // Vercel's request body limit is 4.5MB.

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const auth = { apikey: key, Authorization: `Bearer ${key}` };
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File) || file.size === 0) return NextResponse.json({ ok: false, error: "No file was received." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ ok: false, error: "Files must be under 4MB. For bigger files, paste a Google Drive link instead." }, { status: 400 });
  await fetch(`${url}/storage/v1/bucket`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true, file_size_limit: 5_242_880 }) }).catch(() => {});
  const safe = file.name.replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_").slice(-80) || "file";
  const path = `notes/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}/${safe}`;
  const up = await fetch(`${url}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "POST", headers: { ...auth, "content-type": file.type || "application/octet-stream", "x-upsert": "true" }, body: await file.arrayBuffer(),
  });
  if (!up.ok) return NextResponse.json({ ok: false, error: `The file could not be saved (${up.status}).` }, { status: 502 });
  return NextResponse.json({ ok: true, url: `${url}/storage/v1/object/public/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`, name: file.name });
}
