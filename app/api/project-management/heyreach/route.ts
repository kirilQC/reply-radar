// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * Live HeyReach snapshot for one client, for the hover card on each By client column header.
 *
 * Asked of HeyReach on the spot (the same read the morning brief makes), because this is used on the
 * team call to decide what needs priority: active campaigns, who is sending them, leads still pending,
 * and how many days of sending those leads cover at the per-sender daily cap.
 */

import { NextResponse } from "next/server";
import { gatherLiveFigures } from "../../../lib/morning-brief-run";
import { DAILY_CONNECTIONS_PER_SENDER, sendingDaysLeft } from "../../../../shared/sending-runway.mjs";

export const maxDuration = 30;

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, error: "Supabase is not configured." }, { status: 503 });
  const slug = new URL(request.url).searchParams.get("client")?.trim() ?? "";
  if (!slug) return NextResponse.json({ ok: false, error: "No client given." }, { status: 400 });

  const rows = await fetch(`${url}/rest/v1/rr_workspaces?select=name,heyreach_api_key_ciphertext&slug=eq.${encodeURIComponent(slug)}&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: "no-store",
  }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const workspace = Array.isArray(rows) ? rows[0] : null;
  if (!workspace) return NextResponse.json({ ok: false, error: "That client does not exist." }, { status: 404 });
  if (!workspace.heyreach_api_key_ciphertext) return NextResponse.json({ ok: true, connected: false, campaigns: [] });

  const live = await gatherLiveFigures(String(workspace.heyreach_api_key_ciphertext));
  if (!live.available) return NextResponse.json({ ok: false, error: live.reason || "HeyReach could not be reached." }, { status: 502 });

  // Running campaigns with leads left, plus paused ones that still have leads left (tagged), so a paused
  // campaign someone forgot to restart is visible. (Ema's "missing" campaigns were really EM031v2, which
  // the campaign-code check used to drop; see shared/campaign-code.mjs.)
  const shown = live.campaigns.filter((c) => c.isActive || (/PAUS|HOLD/i.test(c.status) && c.pending > 0));
  const campaigns = shown
    .map((c) => ({
      name: c.name,
      pending: c.pending,
      senders: c.senders,
      senderCount: c.senderIds.length,
      daysLeft: sendingDaysLeft(c.pending, c.senderIds.length),
      paused: !c.isActive,
    }))
    .sort((a, b) => Number(a.paused) - Number(b.paused) || b.pending - a.pending);
  // Totals count running campaigns only; paused ones are listed for context but aren't sending.
  const running = shown.filter((c) => c.isActive);
  const pending = running.reduce((sum, c) => sum + c.pending, 0);
  const senderCount = new Set(running.flatMap((c) => c.senderIds)).size;
  return NextResponse.json({
    ok: true,
    connected: true,
    at: new Date().toISOString(),
    perSenderDaily: DAILY_CONNECTIONS_PER_SENDER,
    total: { pending, senders: senderCount, daysLeft: sendingDaysLeft(pending, senderCount) },
    campaigns,
    // Everything else HeyReach listed, so a campaign that should be here but isn't can be explained.
  });
}
