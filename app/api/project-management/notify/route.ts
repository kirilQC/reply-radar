// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

// Posts a single project's current status to that client's internal Slack channel — the per-row "send
// update to Slack" button on the Project management table. Good for visibility: mark something done, click
// the Slack icon, the team sees it.
import { NextResponse } from "next/server";
import { postMessage } from "../../../lib/slack";
import { STAGE_LABEL } from "../../../lib/project-tasks";

const STAGE_EMOJI: Record<string, string> = { todo: "📝", in_progress: "🔄", paused: "⏸️", completed: "✅", launched: "🚀" };
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

  const wr = await fetch(`${c.url}/rest/v1/rr_workspaces?select=name,slack_internal_channel_id&id=eq.${encodeURIComponent(String((task as Row).workspace_id))}&limit=1`, { headers: c.headers, cache: "no-store" });
  const [ws] = wr.ok ? await wr.json().catch(() => []) : [];
  const clientName = String((ws as Row)?.name ?? "the client");
  // A view/board can override where its updates post (e.g. a Healthtech team channel); otherwise the client's own internal channel.
  const override = String(b.channel ?? "").trim();
  const channel = override || String((ws as Row)?.slack_internal_channel_id ?? "").trim();
  if (!channel) return NextResponse.json({ ok: false, error: `No internal Slack channel is set for ${clientName}. Add it from the Project management directory.` }, { status: 400 });

  const t = task as Row;
  const stage = String(t.stage ?? "todo");
  const emoji = STAGE_EMOJI[stage] ?? "📌";
  const owners = String(t.owner ?? "").trim();
  const priority = String(t.priority ?? "").trim();
  const due = String(t.due_date ?? "").trim();
  const links = Array.isArray(t.links) ? (t.links as (string | { url: string; title?: string })[]) : [];
  const lines = [
    `${emoji} *Project update — ${clientName}*`,
    `*${String(t.title ?? "Untitled")}*`,
    `Status: *${STAGE_LABEL[stage] ?? stage}*`,
  ];
  if (owners) lines.push(`Owner: ${owners}`);
  if (priority) lines.push(`Priority: ${priority.charAt(0).toUpperCase()}${priority.slice(1)}`);
  if (due) lines.push(`Due: ${due}`);
  if (t.context) lines.push(`\n${String(t.context).slice(0, 600)}`);
  for (const l of links.slice(0, 5)) { const u = typeof l === "string" ? l : l?.url; const title = typeof l === "string" ? "" : l?.title; if (u) lines.push(title ? `• <${u}|${title}>` : `• ${u}`); }

  try {
    const ts = await postMessage(channel, lines.join("\n"));
    return NextResponse.json({ ok: true, channel, ts });
  } catch (e) {
    return NextResponse.json({ ok: false, error: `Slack rejected the message${e instanceof Error ? `: ${e.message}` : ""}.` }, { status: 502 });
  }
}
