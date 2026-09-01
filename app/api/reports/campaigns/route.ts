// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The campaigns a report could talk about, fetched before the report is generated.
 *
 * This exists so the choice of campaigns is made *before* Generate rather than after. Toggling
 * afterwards would leave three things disagreeing: the document on screen, the write-up Claude already
 * composed, and the copy filed in the archive. Asking HeyReach first costs about a second and keeps
 * all three the same document.
 *
 * Read-only, and never fails hard: a client with no key still opens the builder, with the campaign
 * list marked unavailable.
 */
import { NextResponse } from "next/server";
import { allCampaigns, campaignStatusFor } from "../../../lib/heyreach-campaigns";

type Row = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : typeof value === "number" ? String(value) : "");

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });

  const slug = text(new URL(request.url).searchParams.get("workspace"));
  if (!slug) return NextResponse.json({ ok: false, error: "workspace required" }, { status: 400 });

  try {
    const response = await fetch(
      `${url}/rest/v1/rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext${slug === "all" ? "" : `&slug=eq.${encodeURIComponent(slug)}`}&slug=neq.misc&order=name.asc`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store" },
    );
    if (!response.ok) throw new Error(`Supabase ${response.status}`);
    const workspaces = (await response.json()) as Row[];
    if (!workspaces.length) return NextResponse.json({ ok: false, error: "No matching client." }, { status: 404 });

    const clients = await Promise.all(
      workspaces.map(async (workspace) => {
        const status = await campaignStatusFor(text(workspace.heyreach_api_key_ciphertext));
        return {
          workspace: { id: text(workspace.id), name: text(workspace.name), slug: text(workspace.slug) },
          available: status.available,
          reason: status.reason,
          // Flattened rather than grouped by state: the builder shows one list of checkboxes, and each
          // row already carries the state it belongs to.
          campaigns: allCampaigns(status),
        };
      }),
    );

    return NextResponse.json({ ok: true, clients });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Could not list campaigns." },
      { status: 502 },
    );
  }
}
