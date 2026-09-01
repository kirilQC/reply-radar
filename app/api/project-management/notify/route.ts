// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Posts a single project's current status to that client's internal Slack channel — the per-row "send
// update to Slack" button on the Project management table. Good for visibility: mark something done, click
// the Slack icon, the team sees it.
import { NextResponse } from "next/server";
import { postMessage } from "../../../lib/slack";
import { STAGE_LABEL } from "../../../lib/project-tasks";

type Row = Record<string, unknown>;
function creds() { const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY; return url && key ? { url, key, headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" } } : null; }

export async function POST(request: Request) {
  const c = creds(); if (!c) return NextResponse.json({ ok: false, error: "Supabase not configured" }, { status: 503 });
  const b = await request.json().catch(() => ({}));
  const id = String(b.id || "").trim();
  if (!id) return NextResponse.json({ ok: false, error: "id required" }, { status: 400 });

  const tr = await fetch(`${c.url}/rest/v1/rr_projects?select=*&id=eq.${encodeURIComponent(id)}&limit=1`, { headers: c.headers, cache: "no-store" });
  const [task] = tr.ok ? await tr.json().catch(() => []) : [];
  if (!task) return NextResponse.json({ ok: false, error: "That task no longer exists." }, { status: 404 });

  const wr = await fetch(`${c.url}/rest/v1/rr_workspaces?select=name,logo_url,slack_internal_channel_id&id=eq.${encodeURIComponent(String((task as Row).workspace_id))}&limit=1`, { headers: c.headers, cache: "no-store" });
  const [ws] = wr.ok ? await wr.json().catch(() => []) : [];
  const clientName = String((ws as Row)?.name ?? "the client");
  const logoUrl = String((ws as Row)?.logo_url ?? "").trim();
  // A view/board can override where its updates post (e.g. a Healthtech team channel); otherwise the client's own internal channel.
  const override = String(b.channel ?? "").trim();
  const channel = override || String((ws as Row)?.slack_internal_channel_id ?? "").trim();
  if (!channel) return NextResponse.json({ ok: false, error: `No internal Slack channel is set for ${clientName}. Add it from the Project management directory.` }, { status: 400 });

  const t = task as Row;
  const stage = String(t.stage ?? "todo");
  const owners = String(t.owner ?? "").trim();
  const priority = String(t.priority ?? "").trim();
  const due = String(t.due_date ?? "").trim();
  const lines = [
    `*Project update - ${clientName}*`,
    "",
    `*Name:* ${String(t.title ?? "Untitled")}`,
    `*Status:* ${STAGE_LABEL[stage] ?? stage}`,
  ];
  if (owners) lines.push(`*Owner:* ${owners}`);
  if (priority) lines.push(`*Priority:* ${priority.charAt(0).toUpperCase()}${priority.slice(1)}`);
  if (due) lines.push(`*Due:* ${due}`);
  const body_text = lines.join("\n");
  // Client logo off to the side, like a section with an image accessory.
  const useLogo = /^https:\/\//i.test(logoUrl);
  const blocks = useLogo ? [{ type: "section", text: { type: "mrkdwn", text: body_text }, accessory: { type: "image", image_url: logoUrl, alt_text: clientName } }] : undefined;

  try {
    const ts = await postMessage(channel, body_text, "", blocks);
    return NextResponse.json({ ok: true, channel, ts });
  } catch {
    // If Slack rejects the image (e.g. it can't fetch the logo), fall back to a plain text post.
    try { const ts = await postMessage(channel, body_text); return NextResponse.json({ ok: true, channel, ts }); }
    catch (e) { return NextResponse.json({ ok: false, error: `Slack rejected the message${e instanceof Error ? `: ${e.message}` : ""}.` }, { status: 502 }); }
  }
}
