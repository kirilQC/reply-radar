// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { resolveModel } from "../../../../shared/anthropic-model.mjs";
import { DEFAULT_SENTIMENT_PROMPT } from "../../../lib/reply-sentiment";
import { DEFAULT_ICP_DOC_PROMPT, ICP_DOC_PROMPT_KEY } from "../../../lib/brain-icp";
import { DEFAULT_MORNING_BRIEF_PROMPT, MORNING_BRIEF_PROMPT_PREFIX, morningBriefPromptKey } from "../../../lib/morning-brief";
import { explainConfigError, readConfig, readConfigPrefix, writeConfig } from "../../../lib/app-config";

type Row = Record<string, unknown>;

/** The global prompt, and one variant per client that overrides it. */
const SENTIMENT_PREFIX = "sentiment_prompt";
const sentimentKey = (workspace: string | null) => (workspace ? `${SENTIMENT_PREFIX}_${workspace}` : SENTIMENT_PREFIX);
const asPrompt = (value: unknown) => (typeof value === "string" ? value : "");

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
    // The global sentiment prompt and every client's override, in one read. A failure here is not fatal:
    // the built-in default is what the scorer falls back to anyway.
    const prompts = await readConfigPrefix(SENTIMENT_PREFIX).catch(() => new Map<string, unknown>());
    // The instructions the QC Brain's "Generate ICP document" button runs on. Read here rather than
    // from its own endpoint because this is the screen that edits it, and a second round trip to fill
    // one textarea is a second thing that can fail.
    const icpDoc = asPrompt(await readConfig(ICP_DOC_PROMPT_KEY).catch(() => "")) || DEFAULT_ICP_DOC_PROMPT;
    // Same shape as the sentiment prompt: one global set of instructions, and a per-client override for
    // the client whose briefs need to read differently. Read as a prefix so both arrive in one round trip.
    const briefPrompts = await readConfigPrefix(MORNING_BRIEF_PROMPT_PREFIX).catch(() => new Map<string, unknown>());

    const globalPrompt = asPrompt(prompts.get(SENTIMENT_PREFIX)) || DEFAULT_SENTIMENT_PROMPT;
    const workspacePrompt = workspace ? asPrompt(prompts.get(sentimentKey(workspace))) || null : null;

    // Anthropic API status
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const anthropicModel = resolveModel(process.env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001");
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
          followUpThreshold: Number(guardrails.follow_up_threshold ?? 50),
          sentimentPrompt: workspacePrompt ?? "",
          morningBriefPrompt: asPrompt(briefPrompts.get(morningBriefPromptKey(workspace))),
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
      icpDocPrompt: icpDoc,
      defaultIcpDocPrompt: DEFAULT_ICP_DOC_PROMPT,
      morningBriefPrompt: asPrompt(briefPrompts.get(morningBriefPromptKey())) || DEFAULT_MORNING_BRIEF_PROMPT,
      defaultMorningBriefPrompt: DEFAULT_MORNING_BRIEF_PROMPT,
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
      // This used to return `{ ok: upsertResponse.ok }` against `rr_global_config`, which has no `key`
      // column — so the save failed every time and the page reported it as `ok: false` with no
      // explanation, which reads as nothing happening. A write that fails must now say why.
      try {
        const scope = typeof workspace === "string" && workspace.trim() ? workspace.trim() : null;
        await writeConfig(sentimentKey(scope), typeof value === "string" ? value : "");
      } catch (error) {
        return NextResponse.json(
          { ok: false, error: explainConfigError(error, "Could not save the prompt.") },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "save_morning_brief_prompt") {
      // A blank value is a deletion, not an empty prompt: clearing a client's override should fall back
      // to the global instructions, and saving "" as the override would instead send the model nothing.
      try {
        const scope = typeof workspace === "string" && workspace.trim() ? workspace.trim() : null;
        await writeConfig(morningBriefPromptKey(scope), typeof value === "string" ? value.trim() : "");
      } catch (error) {
        return NextResponse.json(
          { ok: false, error: explainConfigError(error, "Could not save the prompt.") },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "save_icp_doc_prompt") {
      try {
        await writeConfig(ICP_DOC_PROMPT_KEY, typeof value === "string" ? value : "");
      } catch (error) {
        return NextResponse.json(
          { ok: false, error: explainConfigError(error, "Could not save the prompt.") },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "save_workspace_ai") {
      const { brief, icpPrompt, followUpPrompt, replyPrompt, model, followUpThreshold } = body;
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
          anthropic_model: (model ?? ws.anthropic_model) ? resolveModel(String(model ?? ws.anthropic_model)) : null,
          guardrails: {
            ...guardrails,
            icp_prompt: icpPrompt ?? guardrails.icp_prompt ?? "",
            follow_up_prompt: followUpPrompt ?? guardrails.follow_up_prompt ?? "",
            reply_prompt: replyPrompt ?? guardrails.reply_prompt ?? "",
            follow_up_threshold: followUpThreshold !== undefined
              ? Math.max(0, Math.min(100, Number(followUpThreshold) || 0))
              : guardrails.follow_up_threshold ?? 50,
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
