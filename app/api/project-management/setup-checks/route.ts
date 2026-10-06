// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * What a client's portal is missing, for the alerts at the top of that client's project management page.
 *
 * The QC Portal only shows a client its Messaging and Weekly calls tabs once their QC Brain folder has
 * something in them: campaign messaging synced from the linked Google Doc, and call recaps written by the
 * call-analysis job. When either is empty the tab simply is not there, which is easy to never notice — so
 * this names the gap and the fix, here, where the account team works on the client every day.
 *
 * Read-only: the workspace row, and the brain's file tree (cached for a few minutes by brainTree).
 */
import { NextResponse } from "next/server";
import { brainTree } from "../../../lib/brain";
import { brainFolderFor } from "../../../../shared/brain-link.mjs";

type Gap = { key: string; level: "missing" | "stale"; title: string; detail: string; action: { label: string; href: string } };

/** A recap older than this is flagged as stale even though the tab exists. */
const STALE_CALL_DAYS = 14;
const validSlug = (slug: string) => /^[a-z0-9-]{1,80}$/.test(slug);

function creds() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return url && key ? { url, headers: { apikey: key, Authorization: `Bearer ${key}`, "content-type": "application/json" } } : null;
}

export async function GET(request: Request) {
  const slug = new URL(request.url).searchParams.get("slug") ?? "";
  if (!validSlug(slug)) return NextResponse.json({ ok: false, error: "No client given." }, { status: 400 });
  const c = creds();
  if (!c) return NextResponse.json({ ok: false, error: "Supabase not configured." }, { status: 503 });

  try {
    const response = await fetch(
      `${c.url}/rest/v1/rr_workspaces?select=name,slug,brain_folder,guardrails,call_analysis_enabled,granola_title_match&slug=eq.${encodeURIComponent(slug)}&limit=1`,
      { headers: c.headers, cache: "no-store" },
    );
    const workspace = (response.ok ? ((await response.json()) as Record<string, unknown>[]) : [])[0];
    if (!workspace) return NextResponse.json({ ok: false, error: "That client was not found." }, { status: 404 });

    const tree = await brainTree();
    const folders = [...new Set(tree.map((file) => file.path.split("/")).filter((parts) => parts[0] === "clients" && parts.length > 2).map((parts) => parts[1]))];
    const { folder } = brainFolderFor({ slug: workspace.slug, name: workspace.name, brainFolder: workspace.brain_folder }, folders) as { folder: string };
    const gaps: Gap[] = [];

    if (!folder) {
      gaps.push({
        key: "brain-folder", level: "missing",
        title: "Link a QC Brain folder to this client",
        detail: "No QC Brain folder matches this client, so nothing can be synced for their portal: no messaging, no call recaps, no brain.",
        action: { label: "Open workspace settings", href: "/admin" },
      });
      return NextResponse.json({ ok: true, folder: null, gaps });
    }

    const inFolder = (sub: string) => tree.filter((file) => file.path.startsWith(`clients/${folder}/${sub}/`) && /\.(md|markdown|txt)$/i.test(file.path));

    // Messaging: synced from the Google Doc linked in the workspace settings.
    const guardrails = (workspace.guardrails && typeof workspace.guardrails === "object" ? workspace.guardrails : {}) as Record<string, unknown>;
    const docUrl = String(guardrails.messaging_doc_url ?? "").trim();
    if (!inFolder("Campaign messaging").length) {
      gaps.push(docUrl
        ? {
            key: "messaging-sync", level: "missing",
            title: "Messaging doc is linked, but nothing has synced",
            detail: "The linked doc has produced no Campaign messaging files yet, so the portal's Messaging tab is hidden. Check the doc is shared with QC Command and has one tab per campaign.",
            action: { label: "Open workspace settings", href: "/admin" },
          }
        : {
            key: "messaging-doc", level: "missing",
            title: "Add a messaging doc to this client's workspace",
            detail: "No campaign messaging doc is linked, so the client's portal hides its Messaging tab.",
            action: { label: "Open workspace settings", href: "/admin" },
          });
    }

    // Weekly calls: recaps written by the call-analysis job, named `<YYYY-MM-DD>-<title>.md`.
    const calls = inFolder("Weekly calls");
    const enabled = Boolean(workspace.call_analysis_enabled);
    const titleMatch = String(workspace.granola_title_match ?? "").trim();
    if (!calls.length) {
      gaps.push(!enabled
        ? {
            key: "calls-setup", level: "missing",
            title: "Set up the weekly calls recap system",
            detail: "Call analysis is off for this client, so no recaps are written and the client's portal hides its Weekly calls tab.",
            action: { label: "Open call analysis", href: "/slack" },
          }
        : {
            key: "calls-none", level: "missing",
            title: titleMatch ? "Weekly call recaps are on, but none has been written yet" : "Weekly call recaps are on, but no Granola title match is set",
            detail: titleMatch
              ? `No Granola call matching "${titleMatch}" has produced a recap. Check the meeting title and that the call was recorded.`
              : "Without a Granola title match the job cannot tell which calls are this client's, so no recap is written.",
            action: { label: titleMatch ? "Open call analysis" : "Open workspace settings", href: titleMatch ? "/slack" : "/admin" },
          });
    } else {
      const latest = calls.map((file) => file.path.split("/").pop()?.slice(0, 10) ?? "").filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day)).sort().pop();
      const days = latest ? Math.floor((Date.now() - Date.parse(`${latest}T12:00:00Z`)) / 86_400_000) : null;
      if (days != null && days > STALE_CALL_DAYS) {
        gaps.push({
          key: "calls-stale", level: "stale",
          title: `No weekly call recap in ${days} days`,
          detail: `The last recap is from ${latest}. If calls are still happening, the recap job is not picking them up.`,
          action: { label: "Open call analysis", href: "/slack" },
        });
      }
    }

    return NextResponse.json({ ok: true, folder, gaps });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "The setup checks did not run.", gaps: [] }, { status: 502 });
  }
}
