// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { loadDestination, rows, saveDestination } from "../../../../lib/crm-push";
import { OAUTH_ORIGIN, exchangeCode, readOauthState } from "../../../../lib/hubspot-user";

/**
 * Where HubSpot sends the QC Growth user back after approving QC Growth's app in a client's portal. The
 * sign-in is kept only when it is for the portal this client's service key belongs to, so one client's
 * dashboards can never be built in another client's HubSpot.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const slug = readOauthState(params.get("state") ?? "");
  const back = (query: string) => NextResponse.redirect(`${OAUTH_ORIGIN}/operations/${slug ?? ""}?${query}`);
  if (!slug) return NextResponse.redirect(`${OAUTH_ORIGIN}/onboarding?hubspot_error=${encodeURIComponent("That HubSpot sign-in link expired. Try Connect again.")}`);
  if (params.get("error")) return back(`hubspot_error=${encodeURIComponent(params.get("error_description") ?? params.get("error") ?? "HubSpot sign-in was cancelled.")}`);
  try {
    const c = { url: process.env.SUPABASE_URL ?? "", key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "" };
    const [workspace] = await rows(c, `rr_workspaces?select=id,name&slug=eq.${encodeURIComponent(slug)}&limit=1`);
    if (!workspace) throw new Error("Unknown client.");
    const workspaceId = String(workspace.id);
    const destination = await loadDestination(c, workspaceId, "crm");
    if (!destination?.account_id) throw new Error("Connect the client's HubSpot service key first.");
    const user = await exchangeCode(OAUTH_ORIGIN, params.get("code") ?? "");
    if (user.hub_id !== destination.account_id) throw new Error(`That sign-in was for HubSpot account ${user.hub_id}, not ${String(workspace.name ?? "this client")}'s (${destination.account_id}). Pick ${String(workspace.name ?? "the client's")} account when HubSpot asks.`);
    await saveDestination(c, workspaceId, "crm", { config: { ...(destination.config ?? {}), hubspot_user: user } });
    return back("hubspot=connected");
  } catch (error) {
    return back(`hubspot_error=${encodeURIComponent(error instanceof Error ? error.message : "HubSpot sign-in failed.")}`);
  }
}
