// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// The premade client-update messages behind the onboarding panel's dropdown: list, add, rename/edit, delete.
// Global (not per-client) — the same shortlist is offered on every client's page.
import { NextResponse } from "next/server";
import { listClientTemplates, addClientTemplate, updateClientTemplate, deleteClientTemplate } from "../../../lib/client-templates";

export async function GET() {
  const templates = await listClientTemplates();
  return NextResponse.json({ ok: true, templates });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { label?: unknown; body?: unknown };
  const created = await addClientTemplate(
    typeof body.label === "string" ? body.label : undefined,
    typeof body.body === "string" ? body.body : undefined,
  );
  if (!created) return NextResponse.json({ ok: false, error: "Could not add the template." }, { status: 400 });
  return NextResponse.json({ ok: true, template: created });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; label?: unknown; body?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ ok: false, error: "Missing template id." }, { status: 400 });
  const ok = await updateClientTemplate(id, {
    label: typeof body.label === "string" ? body.label : undefined,
    body: typeof body.body === "string" ? body.body : undefined,
  });
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: "Could not save." }, { status: 400 });
}

export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { id?: unknown };
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ ok: false, error: "Missing template id." }, { status: 400 });
  const ok = await deleteClientTemplate(id);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ ok: false, error: "Could not delete." }, { status: 400 });
}
