// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { positionsForOrder } from "../../../../shared/onboarding.mjs";
import { listTemplate, addTemplateStep, updateTemplateStep, deleteTemplateStep, reorderTemplate } from "../../../lib/onboarding";

// The editable master template — the "client template box". GET the whole thing, POST a new step, PATCH to
// edit one or to reorder a sibling group, DELETE a step (its sub-steps cascade).
export async function GET() {
  const steps = await listTemplate();
  return NextResponse.json({ ok: true, steps });
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => ({}));
  const result = await addTemplateStep({
    title: String(payload?.title ?? ""),
    section: payload?.section,
    description: payload?.description,
    parentId: payload?.parentId,
    position: typeof payload?.position === "number" ? payload.position : undefined,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, step: result.step }, { status: 201 });
}

export async function PATCH(request: Request) {
  const payload = await request.json().catch(() => ({}));
  // A reorder hands back the new order of one sibling group as a list of ids; everything else edits a step.
  if (Array.isArray(payload?.reorder)) {
    const result = await reorderTemplate(positionsForOrder(payload.reorder));
    return NextResponse.json({ ok: result.ok, error: result.error });
  }
  const id = String(payload?.id ?? "");
  const result = await updateTemplateStep(id, {
    title: payload?.title,
    section: payload?.section,
    description: payload?.description,
    isActive: payload?.isActive,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const payload = await request.json().catch(() => ({}));
  const result = await deleteTemplateStep(String(payload?.id ?? ""));
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
