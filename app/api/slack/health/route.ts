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
import { inspectNotes, type NoteSighting } from "../../../lib/granola";
import { describeNeedles, parseTitleNeedles } from "../../../lib/granola-match";
import { granolaKeys } from "../../../lib/morning-brief-run";
import { probeChannel, tokenReports, type ChannelProbe } from "../../../lib/slack";

export const maxDuration = 60;

const TEST_CHANNEL_ENV = "SLACK_TEST_CHANNEL_ID";

/** The same window the brief searches, so this cannot report a call the brief would not have used. */
const CALL_WINDOW_DAYS = 14;

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
  let needles: string[][] = [];
  let granola: NoteSighting[] = [];
  const store = credentials();
  if (slug && store) {
    const read = async (path: string): Promise<unknown> => {
      const response = await fetch(`${store.url}/rest/v1/${path}`, { headers: { apikey: store.key, Authorization: `Bearer ${store.key}` }, cache: "no-store" });
      return response.ok ? response.json() : [];
    };
    const rows = (await read(`rr_workspaces?slug=eq.${encodeURIComponent(slug)}&select=name,slack_internal_channel_id,slack_external_channel_id,granola_title_match&limit=1`).catch(() => [])) as Record<string, unknown>[];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (row) {
      client = String(row.name ?? slug);
      needles = parseTitleNeedles(row.granola_title_match, client);
      targets.push(
        ["Internal channel", String(row.slack_internal_channel_id ?? "").trim()],
        ["External channel", String(row.slack_external_channel_id ?? "").trim()],
      );
      // The same window the brief uses, so "found nothing" here means the brief found nothing too.
      granola = await inspectNotes(await granolaKeys(read), needles, CALL_WINDOW_DAYS).catch(() => []);
    }
  }

  // Sequential. Six probes at once against one workspace is how you turn a diagnostic into a
  // `ratelimited` error and spend an afternoon debugging the debugger.
  const channels: ChannelProbe[] = [];
  for (const [label, id] of targets) channels.push(await probeChannel(label, id));

  // Every note each key can see, ticked if its title names this client. A call that is in the list but
  // not ticked needs a name typing into the config page; a call that is in no list at all is in somebody
  // else's Granola and needs their key.
  return NextResponse.json({
    ok: true,
    client,
    tokens,
    channels,
    granola: {
      windowDays: CALL_WINDOW_DAYS,
      matchingOn: describeNeedles(needles),
      keys: granola.map((sighting) => ({
        key: sighting.keyLabel,
        error: sighting.error,
        matched: sighting.notes.filter((note) => note.matches).length,
        notes: sighting.notes.map((note) => ({
          title: note.title,
          when: note.startedAt ? new Date(note.startedAt).toISOString().slice(0, 10) : "no date",
          matches: note.matches,
        })),
      })),
    },
  });
}
