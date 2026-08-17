// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The morning brief: the client directory the Slack hub lists, and the one call that writes a brief.
 *
 * ── Why generating and sending are the same request ──────────────────────────────────────────────
 * A brief that was written but not sent is not half-done work, it is a preview — and a preview that
 * had to be stored and then referred to by id in a second request would mean a brief could be edited
 * between the two, which is precisely the thing nobody should be able to do to a figure. So the model
 * call and the Slack post happen together, and `destination` decides at the outset which of the three
 * it is: shown on the page, posted to the test channel, or posted to the client's own channel.
 *
 * ── Every attempt is recorded, including the failures ────────────────────────────────────────────
 * A row goes into `rr_slack_briefs` whether or not Slack accepted the message, because the question
 * the hub has to answer is "did this client get a brief" and a failed send answers that as firmly as a
 * successful one. The rendered text is stored too, so a brief can be re-read without another model
 * call, and so what was actually said is auditable rather than merely that something was.
 */

import { NextResponse } from "next/server";
import { briefUserContent, gatherSignals, type BriefWorkspace } from "../../../lib/morning-brief";
import { gatherChannels, morningBriefPrompt, writeBrief } from "../../../lib/morning-brief-run";
import { postMessage, slackConfigured, SLACK_TOKEN_ENV } from "../../../lib/slack";

// One model call at a 45s timeout, inside Hobby's 60s ceiling. No chunking: a brief is ~1,400 output
// tokens by design, and the whole point of it is that it is short enough to read before standup.
export const maxDuration = 60;

type Row = Record<string, unknown>;

/** The channel a brief goes to when it is being tried out rather than delivered. */
const TEST_CHANNEL_ENV = "SLACK_TEST_CHANNEL_ID";

function credentials() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, key } : null;
}

function reader(url: string, key: string) {
  return async (path: string): Promise<unknown> => {
    const response = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      cache: "no-store",
    });
    if (!response.ok) {
      // PostgREST's own message is the whole answer when a column is missing — "column
      // rr_workspaces.slack_internal_channel_id does not exist" tells a teammate to run the migration,
      // where "HTTP 400" tells them nothing and sends them here to read this file.
      const detail = (await response.json().catch(() => null)) as { message?: string; hint?: string } | null;
      throw new Error(detail?.message ? `Supabase refused the read: ${detail.message}` : `Supabase refused the read: HTTP ${response.status}`);
    }
    return response.json();
  };
}

async function insertBrief(url: string, key: string, row: Row): Promise<void> {
  await fetch(`${url}/rest/v1/rr_slack_briefs`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
    cache: "no-store",
  }).catch(() => null);
}

/**
 * The client directory, with the one fact per client that decides whether a brief is worth running:
 * whether it has any channel at all, and when it last got one.
 */
export async function GET() {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  const { url, key } = credential;
  const read = reader(url, key);

  try {
    const [workspaceRows, briefRows] = await Promise.all([
      read("rr_workspaces?select=id,name,slug,logo_url,accent_color,timezone,client_brief,slack_internal_channel_id,slack_external_channel_id&order=name.asc"),
      // Every client's brief history in one read rather than one read per client. 200 rows is roughly a
      // year of three-a-week briefs for a dozen clients, and only the newest per client is used.
      read("rr_slack_briefs?select=workspace_id,created_at,status,destination,slack_channel_id&automation=eq.morning_brief&order=created_at.desc&limit=200").catch(() => []),
    ]);

    const briefs = Array.isArray(briefRows) ? (briefRows as Row[]) : [];
    const latest = new Map<string, Row>();
    for (const brief of briefs) {
      const id = String(brief.workspace_id ?? "");
      if (id && !latest.has(id)) latest.set(id, brief);
    }

    const workspaces = (Array.isArray(workspaceRows) ? (workspaceRows as Row[]) : []).map((workspace) => {
      const id = String(workspace.id ?? "");
      const last = latest.get(id);
      return {
        id,
        name: String(workspace.name ?? ""),
        slug: String(workspace.slug ?? ""),
        logoUrl: workspace.logo_url ?? null,
        accentColor: workspace.accent_color ?? null,
        internalChannelId: String(workspace.slack_internal_channel_id ?? ""),
        externalChannelId: String(workspace.slack_external_channel_id ?? ""),
        hasBrief: Boolean(String(workspace.client_brief ?? "").trim()),
        lastBriefAt: last ? String(last.created_at ?? "") : null,
        lastBriefStatus: last ? String(last.status ?? "") : null,
        lastBriefDestination: last ? String(last.destination ?? "") : null,
      };
    });

    return NextResponse.json({
      ok: true,
      slack: { configured: slackConfigured(), tokenEnv: SLACK_TOKEN_ENV, testChannelId: (process.env[TEST_CHANNEL_ENV] ?? "").trim() },
      anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY),
      workspaces,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load the client list." }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const credential = credentials();
  if (!credential) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });
  const { url, key } = credential;
  const read = reader(url, key);

  let workspace: BriefWorkspace | null = null;
  let destination = "preview";

  try {
    const body = (await request.json().catch(() => ({}))) as Row;
    const slug = typeof body.workspace === "string" ? body.workspace.trim() : "";
    destination = body.destination === "test" || body.destination === "internal" ? body.destination : "preview";
    if (!slug) return NextResponse.json({ error: "No client was named." }, { status: 400 });

    const rows = await read(`rr_workspaces?select=id,name,slug,timezone,client_brief,slack_internal_channel_id,slack_external_channel_id&slug=eq.${encodeURIComponent(slug)}&limit=1`);
    const found = (Array.isArray(rows) ? (rows as Row[]) : [])[0];
    if (!found) return NextResponse.json({ error: "That client does not exist." }, { status: 404 });
    workspace = found as BriefWorkspace;

    // Worked out before the model call, so a brief that has nowhere to go costs nothing to refuse.
    let channelId = "";
    if (destination === "test") {
      channelId = (process.env[TEST_CHANNEL_ENV] ?? "").trim();
      if (!channelId) return NextResponse.json({ error: `${TEST_CHANNEL_ENV} is not set, so there is no test channel to post to.` }, { status: 400 });
    }
    if (destination === "internal") {
      channelId = String(workspace.slack_internal_channel_id ?? "").trim();
      if (!channelId) return NextResponse.json({ error: `${workspace.name} has no internal channel id. Add one on their configuration page.` }, { status: 400 });
    }
    if (channelId && !slackConfigured()) {
      return NextResponse.json({ error: `${SLACK_TOKEN_ENV} is not set, so nothing can be posted to Slack.` }, { status: 400 });
    }

    const [signals, channels, systemPrompt] = await Promise.all([
      gatherSignals(read, workspace),
      gatherChannels(workspace),
      morningBriefPrompt(workspace.slug),
    ]);

    const body_ = await writeBrief(systemPrompt, briefUserContent(workspace, { signals, ...channels }));

    let messageTs = "";
    let sendError = "";
    if (channelId) {
      try {
        messageTs = await postMessage(channelId, body_);
      } catch (error) {
        // The brief itself succeeded, so it is returned and stored either way — the send is what failed,
        // and saying which of the two went wrong is the difference between a fixable error and a mystery.
        sendError = error instanceof Error ? error.message : "Slack refused the message.";
      }
    }

    await insertBrief(url, key, {
      workspace_id: workspace.id,
      automation: "morning_brief",
      destination,
      slack_channel_id: channelId || null,
      slack_message_ts: messageTs || null,
      body: body_,
      signals,
      status: sendError ? "error" : "success",
      error_text: sendError || null,
    });

    return NextResponse.json({
      ok: !sendError,
      brief: body_,
      signals,
      posted: Boolean(messageTs),
      channelId: channelId || null,
      messageTs: messageTs || null,
      channelNotes: [channels.internal.error, channels.external.error].filter(Boolean),
      error: sendError || undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The brief could not be written.";
    if (workspace) {
      await insertBrief(url, key, {
        workspace_id: workspace.id,
        automation: "morning_brief",
        destination,
        body: "",
        status: "error",
        error_text: message,
      });
    }
    return NextResponse.json({ ok: false, error: message }, { status: 502 });
  }
}
