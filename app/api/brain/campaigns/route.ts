/**
 * The join between what the brain says we would do and what HeyReach says happened.
 *
 * ── Why this is the point of the whole tab ──────────────────────────────────────────────────────
 * A prettier reader for a GitHub repo is worth something but not much; they already have a docs site.
 * What no docs site can do is know that `CT003` in a strategy note is a live campaign with 108
 * conversations and a 53.7% reply rate, because the strategy lives in one system and the numbers live
 * in another. Reply Radar is the only place both are reachable, which is the argument for building
 * this here rather than improving the docs site.
 *
 * ── Matching a folder to a workspace ────────────────────────────────────────────────────────────
 * The brain names clients by folder — `bluevia-health` — and Reply Radar names them by workspace
 * slug and display name. Those agree most of the time and not always, so the match is exact slug,
 * then exact name, then either containing the other. No match is a normal answer rather than an
 * error: plenty of folders in that repo are prospects and old accounts that were never in Reply
 * Radar, and reporting that as a failure would put a red box on half the pages.
 */
import { NextResponse } from "next/server";
import * as heyreach from "../../../lib/heyreach-api";
import { campaignCode, isOurCampaign } from "../../../../shared/campaign-code.mjs";
import { clientLabel } from "../../../../shared/brain-structure.mjs";

type Row = Record<string, unknown>;
const text = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value).trim() : "");

const supabase = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase is not configured.");
  return { url, key };
};

/** The Reply Radar workspace a brain folder refers to, or nothing. */
async function workspaceFor(folder: string) {
  const { url, key } = supabase();
  const response = await fetch(`${url}/rest/v1/rr_workspaces?select=id,name,slug,heyreach_api_key_ciphertext&order=name.asc`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Supabase returned ${response.status}.`);
  const rows = ((await response.json().catch(() => [])) as Row[]) ?? [];
  const wanted = folder.toLowerCase();
  // `clientLabel` first, so `bluevia-health` can match a workspace named "Bluevia Health".
  const label = String(clientLabel(folder)).toLowerCase();
  const named = (row: Row) => text(row.name).toLowerCase();
  const slugged = (row: Row) => text(row.slug).toLowerCase();
  return (
    rows.find((row) => slugged(row) === wanted || named(row) === wanted || named(row) === label) ??
    rows.find((row) => {
      const name = named(row);
      return name.includes(wanted) || wanted.includes(name) || name.includes(label);
    }) ??
    null
  );
}

export async function GET(request: Request) {
  const folder = new URL(request.url).searchParams.get("client")?.trim() ?? "";
  if (!folder) return NextResponse.json({ ok: false, error: "No client was asked for." }, { status: 400 });

  try {
    const workspace = await workspaceFor(folder);
    if (!workspace) {
      // Not an error. Half the folders in the brain are prospects and dormant accounts that were
      // never set up in Reply Radar, and a red box on all of them would train people to ignore it.
      return NextResponse.json({ ok: true, matched: false, client: "", campaigns: [] });
    }
    const apiKey = text(workspace.heyreach_api_key_ciphertext);
    if (!apiKey) {
      return NextResponse.json({ ok: true, matched: true, client: text(workspace.name), connected: false, campaigns: [] });
    }

    const all = await heyreach.statsByCampaign(apiKey, {});
    const campaigns = all
      .filter((row) => isOurCampaign(row.campaignName) && !row.deleted)
      .map((row) => ({
        code: String(campaignCode(row.campaignName)),
        id: row.campaignId,
        name: row.campaignName,
        connectionsSent: row.connectionsSent,
        connectionsAccepted: row.connectionsAccepted,
        conversationsStarted: row.conversationsStarted,
        replies: row.messageReplies,
        // Divided here rather than passing HeyReach's own rate through, because their denominator is
        // undocumented and did not reconcile on a live account. Replies over conversations started is
        // a figure the page can name and defend.
        replyRate: row.conversationsStarted ? (row.messageReplies / row.conversationsStarted) * 100 : 0,
      }))
      .filter((row) => row.code)
      .sort((a, b) => a.code.localeCompare(b.code));

    return NextResponse.json({
      ok: true,
      matched: true,
      connected: true,
      client: text(workspace.name),
      workspace: text(workspace.slug),
      campaigns,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "The campaign figures could not be read." },
      { status: 502 },
    );
  }
}
