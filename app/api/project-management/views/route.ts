// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Custom Project-management views (client groups) — CRUD.
import { NextResponse } from "next/server";
import { listViews, createView, updateView, deleteView } from "../../../lib/project-views";

export async function GET() { return NextResponse.json({ ok: true, views: await listViews() }); }
export async function POST(request: Request) {
  const b = await request.json().catch(() => ({}));
  const r = await createView({ name: String(b.name ?? ""), memberSlugs: Array.isArray(b.memberSlugs) ? b.memberSlugs : [], logoUrl: b.logoUrl, accentColor: b.accentColor });
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
export async function PATCH(request: Request) {
  const b = await request.json().catch(() => ({}));
  if (!b.id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  const r = await updateView(String(b.id), b);
  return NextResponse.json(r, { status: r.ok ? 200 : 400 });
}
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });
  return NextResponse.json(await deleteView(id));
}
