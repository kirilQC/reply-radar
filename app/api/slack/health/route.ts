// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * What Slack thinks of our credentials, and of one client's channels.
 *
 * ── Why this is a route and not a paragraph of documentation ──────────────────────────────────────
 * Every failure in this feature arrives as a Slack error slug against an invisible credential, and the
 * slugs are actively misleading: a private channel the bot was never invited to reports
 * `channel_not_found`, which reads as a wrong id and sends you to check the id, which is correct.
 * The only way out is to ask Slack which token is which and what it can see, so that is what this does.
 *
 * ── One client at a time ─────────────────────────────────────────────────────────────────────────
 * Probing every channel would be three calls times two channels times a dozen clients, which trips
 * Slack's rate limit and answers a question nobody asked. `?slug=` probes one client; without it you
 * get the tokens and the test channel, which is enough to tell whether anything works at all.
 */

import { NextResponse } from "next/server";
import { probeChannel, tokenReports, type ChannelProbe } from "../../../lib/slack";

export const maxDuration = 60;

const TEST_CHANNEL_ENV = "SLACK_TEST_CHANNEL_ID";

function credentials() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

export async function GET(request: Request) {
  const slug = (new URL(request.url).searchParams.get("slug") ?? "").trim();

  // Asked first and reported even if the channel probes fall over, because a bad token makes every
  // channel look broken and the tokens are the answer in that case.
  const tokens = await tokenReports();

  const targets: Array<[string, string]> = [];
  const testChannel = (process.env[TEST_CHANNEL_ENV] ?? "").trim();
  if (testChannel) targets.push(["Test channel", testChannel]);

  let client = "";
  if (slug) {
    const store = credentials();
    if (store) {
      const query = `${store.url}/rest/v1/rr_workspaces?slug=eq.${encodeURIComponent(slug)}&select=name,slack_internal_channel_id,slack_external_channel_id&limit=1`;
      const response = await fetch(query, { headers: { apikey: store.key, Authorization: `Bearer ${store.key}` }, cache: "no-store" }).catch(() => null);
      const rows = response?.ok ? ((await response.json().catch(() => [])) as Record<string, unknown>[]) : [];
      const row = rows[0];
      if (row) {
        client = String(row.name ?? slug);
        const internal = String(row.slack_internal_channel_id ?? "").trim();
        const external = String(row.slack_external_channel_id ?? "").trim();
        targets.push(["Internal channel", internal], ["External channel", external]);
      }
    }
  }

  // Sequential. Six probes at once against one workspace is how you turn a diagnostic into a
  // `ratelimited` error and spend an afternoon debugging the debugger.
  const channels: ChannelProbe[] = [];
  for (const [label, id] of targets) channels.push(await probeChannel(label, id));

  return NextResponse.json({ ok: true, client, tokens, channels });
}
