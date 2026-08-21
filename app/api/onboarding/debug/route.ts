// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";

// Temporary diagnostic for the onboarding hub: it reports whether the two tables read, and attempts one
// real insert into rr_onboarding_tasks so the raw PostgREST/Postgres error (which the app otherwise
// swallows) is visible. It cleans up the probe row it writes. Delete this route once onboarding works.
export async function GET() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase env not set" });
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const writeHeaders = { ...headers, "content-type": "application/json", Prefer: "return=representation" };
  const out: Record<string, unknown> = {};

  const probe = async (label: string, path: string, init?: RequestInit) => {
    try {
      const res = await fetch(`${url}/rest/v1/${path}`, { ...init, headers: init?.method && init.method !== "GET" ? writeHeaders : headers, cache: "no-store" });
      const body = await res.text();
      out[label] = { status: res.status, ok: res.ok, body: body.slice(0, 600) };
      return { status: res.status, ok: res.ok, body };
    } catch (e) {
      out[label] = { error: String(e) };
      return { status: 0, ok: false, body: "" };
    }
  };

  await probe("template_steps_head", "rr_onboarding_template_steps?select=id&limit=1");
  await probe("tasks_head", "rr_onboarding_tasks?select=id&limit=1");
  const ws = await probe("a_workspace", "rr_workspaces?select=id,name&limit=1");
  let workspaceId = "";
  try { workspaceId = String((JSON.parse(ws.body || "[]")[0] || {}).id || ""); } catch { /* leave blank */ }
  out.workspaceId = workspaceId;

  if (workspaceId) {
    const insert = await probe("probe_insert", "rr_onboarding_tasks", {
      method: "POST",
      body: JSON.stringify([{ workspace_id: workspaceId, title: "__probe__", position: 0 }]),
    });
    try {
      const created = JSON.parse(insert.body || "[]")[0];
      if (created?.id) {
        await probe("probe_cleanup", `rr_onboarding_tasks?id=eq.${encodeURIComponent(String(created.id))}`, { method: "DELETE" });
      }
    } catch { /* nothing to clean */ }
  }

  return NextResponse.json({ ok: true, diagnostics: out });
}
