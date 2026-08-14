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
 * slug and display name. Those agree most of the time and not always, which is worse than never
 * agreeing, so the rules live in `shared/brain-link.mjs` where they are tested and where the client
 * index reads them too. A person can overrule the guess per workspace, and that answer wins.
 *
 * No match is a normal answer rather than an error: plenty of folders in that repo are prospects and
 * old accounts that were never in Reply Radar, and reporting that as a failure would put a red box
 * on half the pages.
 */
import { NextResponse } from "next/server";
import * as heyreach from "../../../lib/heyreach-api";
import { brainTree } from "../../../lib/brain";
import { workspacesByFolder } from "../../../lib/brain-workspaces";
import { campaignCode, isOurCampaign } from "../../../../shared/campaign-code.mjs";
import { clientsIn } from "../../../../shared/brain-structure.mjs";

export async function GET(request: Request) {
  const folder = new URL(request.url).searchParams.get("client")?.trim() ?? "";
  if (!folder) return NextResponse.json({ ok: false, error: "No client was asked for." }, { status: 400 });

  try {
    // The whole folder list, not just this one, because a match is only trustworthy relative to the
    // alternatives — the rules have to be able to prefer an exact folder over a loose one.
    const folders = clientsIn((await brainTree()).map((file) => file.path)) as string[];
    const workspace = (await workspacesByFolder(folders)).get(folder);
    if (!workspace) {
      // Not an error. Half the folders in the brain are prospects and dormant accounts that were
      // never set up in Reply Radar, and a red box on all of them would train people to ignore it.
      return NextResponse.json({ ok: true, matched: false, client: "", campaigns: [] });
    }
    if (!workspace.apiKey) {
      return NextResponse.json({ ok: true, matched: true, client: workspace.name, connected: false, campaigns: [] });
    }

    const all = await heyreach.statsByCampaign(workspace.apiKey, {});
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
      client: workspace.name,
      workspace: workspace.slug,
      campaigns,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "The campaign figures could not be read." },
      { status: 502 },
    );
  }
}
