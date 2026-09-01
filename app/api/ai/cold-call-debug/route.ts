import { NextResponse } from "next/server";
import { createView, listViews, deleteView } from "../../../lib/project-views";
export const maxDuration = 30;
export async function GET() {
  const created = await createView({ name: "Healthtech (test)", memberSlugs: ["steadywell", "bluevia"] });
  const views = await listViews();
  const found = views.find(v => v.slug.startsWith("healthtech"));
  if (found) await deleteView(found.id);
  return NextResponse.json({ created, viewCount: views.length, found: found ? { name: found.name, slug: found.slug, members: found.memberSlugs } : null, cleanedUp: !!found });
}
