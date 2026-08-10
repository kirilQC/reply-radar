import { NextResponse } from "next/server";
import { DEFAULT_SENTIMENT_PROMPT } from "../../../lib/reply-sentiment";

type Row = Record<string, unknown>;

async function supabase(url: string, key: string, path: string, init?: RequestInit) {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  return response;
}

export async function GET(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });

  const params = new URL(request.url).searchParams;
  const workspace = params.get("workspace");

  try {
    // Get all AI-related config keys
    const configResponse = await supabase(url, key, "rr_global_config?select=key,value&key=like.sentiment_prompt*");
    const configRows = configResponse.ok ? ((await configResponse.json()) as Row[]) : [];

    const globalPrompt = configRows.find((row) => row.key === "sentiment_prompt")?.value ?? DEFAULT_SENTIMENT_PROMPT;
    const workspacePrompt = workspace
      ? configRows.find((row) => row.key === `sentiment_prompt_${workspace}`)?.value ?? null
      : null;

    // Anthropic API status
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const anthropicModel = process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-latest";
    const maskedKey = anthropicKey ? `sk-ant-...${anthropicKey.slice(-4)}` : null;

    // Get workspace-specific AI context if requested
    let workspaceAi = null;
    if (workspace) {
      const wsResponse = await supabase(url, key, `rr_workspaces?select=id,name,slug,client_brief,anthropic_model,guardrails&slug=eq.${encodeURIComponent(workspace)}&limit=1`);
      const wsRows = wsResponse.ok ? ((await wsResponse.json()) as Row[]) : [];
      if (wsRows.length) {
        const ws = wsRows[0];
        const guardrails = ws.guardrails && typeof ws.guardrails === "object" ? ws.guardrails as Row : {};
        workspaceAi = {
          name: ws.name,
          slug: ws.slug,
          brief: ws.client_brief ?? "",
          model: ws.anthropic_model ?? "",
          icpPrompt: guardrails.icp_prompt ?? "",
          followUpPrompt: guardrails.follow_up_prompt ?? "",
          replyPrompt: guardrails.reply_prompt ?? "",
          sentimentPrompt: workspacePrompt ?? "",
        };
      }
    }

    // Get all workspaces for the sub-tab list
    const allWsResponse = await supabase(url, key, "rr_workspaces?select=id,name,slug,logo_url,accent_color,client_brief&order=name.asc");
    const allWorkspaces = allWsResponse.ok ? ((await allWsResponse.json()) as Row[]).map((ws) => ({
      id: ws.id, name: ws.name, slug: ws.slug, logoUrl: ws.logo_url, accentColor: ws.accent_color, hasBrief: Boolean(ws.client_brief),
    })) : [];

    return NextResponse.json({
      ok: true,
      anthropic: { configured: Boolean(anthropicKey), maskedKey, model: anthropicModel },
      globalSentimentPrompt: globalPrompt,
      defaultSentimentPrompt: DEFAULT_SENTIMENT_PROMPT,
      workspaceAi,
      workspaces: allWorkspaces,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load AI config" }, { status: 502 });
  }
}

export async function POST(request: Request) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return NextResponse.json({ error: "Supabase not configured" }, { status: 503 });

  try {
    const body = await request.json();
    const { action, workspace, value } = body;

    if (action === "save_sentiment_prompt") {
      const configKey = workspace ? `sentiment_prompt_${workspace}` : "sentiment_prompt";
      // Upsert into rr_global_config
      const upsertResponse = await supabase(url, key, "rr_global_config", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key: configKey, value: value ?? "" }),
      });
      return NextResponse.json({ ok: upsertResponse.ok });
    }

    if (action === "save_workspace_ai") {
      const { brief, icpPrompt, followUpPrompt, replyPrompt, model } = body;
      // Update workspace
      const wsResponse = await supabase(url, key, `rr_workspaces?slug=eq.${encodeURIComponent(workspace)}&limit=1`);
      const wsRows = wsResponse.ok ? ((await wsResponse.json()) as Row[]) : [];
      if (!wsRows.length) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
      const ws = wsRows[0];
      const guardrails = ws.guardrails && typeof ws.guardrails === "object" ? ws.guardrails as Row : {};

      await supabase(url, key, `rr_workspaces?slug=eq.${encodeURIComponent(workspace)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          client_brief: brief ?? ws.client_brief,
          anthropic_model: model ?? ws.anthropic_model,
          guardrails: {
            ...guardrails,
            icp_prompt: icpPrompt ?? guardrails.icp_prompt ?? "",
            follow_up_prompt: followUpPrompt ?? guardrails.follow_up_prompt ?? "",
            reply_prompt: replyPrompt ?? guardrails.reply_prompt ?? "",
          },
        }),
      });

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to save AI config" }, { status: 502 });
  }
}
