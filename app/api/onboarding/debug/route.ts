// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";

// Temporary diagnostic for the onboarding hub. Replicates the checklist snapshot exactly — the active
// template read and the real batch insert (with template_step_id/section/description) — so the raw error
// the app swallows is visible. Cleans up every probe row it writes. Delete this route once onboarding works.
export async function GET() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase env not set" });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const writeHeaders = { ...headers, "content-type": "application/json", Prefer: "return=representation" };
  const out: Record<string, unknown> = {};

  const call = async (label: string, path: string, init?: RequestInit) => {
    try {
      const method = init?.method ?? "GET";
      const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: method !== "GET" ? writeHeaders : headers, cache: "no-store" });
      const body = await res.text();
      out[label] = { status: res.status, ok: res.ok, body: body.slice(0, 500) };
      return body;
    } catch (e) {
      out[label] = { error: String(e) };
      return "";
    }
  };

  // 1. The exact read the snapshot uses (with the is_active filter). If this returns [] the snapshot no-ops.
  const activeBody = await call("active_template_steps", "rr_onboarding_template_steps?select=id,parent_id,section,title,description,position,is_active&is_active=eq.true&order=position.asc");
  let steps: Array<Record<string, unknown>> = [];
  try { steps = JSON.parse(activeBody || "[]"); } catch { steps = []; }
  out.active_count = steps.length;

  // 2. A workspace to attach to.
  const wsBody = await call("a_workspace", "rr_workspaces?select=id,name&limit=1");
  let workspaceId = "";
  try { workspaceId = String((JSON.parse(wsBody || "[]")[0] || {}).id || ""); } catch { /* blank */ }
  out.workspaceId = workspaceId;

  // 3. The exact parent payload the snapshot builds, inserted as one batch.
  if (workspaceId && steps.length) {
    const parents = steps.filter((s) => !s.parent_id);
    const payload = parents.map((s) => ({
      workspace_id: workspaceId,
      template_step_id: s.id,
      section: s.section ?? null,
      title: s.title,
      description: s.description ?? null,
      position: s.position,
    }));
    out.parent_payload_count = payload.length;
    out.parent_payload_sample = payload[0];
    const insertBody = await call("snapshot_batch_insert", "rr_onboarding_tasks", { method: "POST", body: JSON.stringify(payload) });
    try {
      const created = JSON.parse(insertBody || "[]");
      if (Array.isArray(created) && created.length) {
        const ids = created.map((r: Record<string, unknown>) => String(r.id)).filter(Boolean);
        await call("probe_cleanup", `rr_onboarding_tasks?id=in.(${ids.map(encodeURIComponent).join(",")})`, { method: "DELETE" });
        out.inserted_count = ids.length;
      }
    } catch { /* nothing to clean */ }
  }

  return NextResponse.json({ ok: true, diagnostics: out });
}
