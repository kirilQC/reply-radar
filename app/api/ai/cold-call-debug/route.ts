import { NextResponse } from "next/server";
import { runTool } from "../../../lib/assistant-tools";
export const maxDuration = 30;
export async function GET() {
  const list = await runTool("list_onboarding_template", {}) as any;
  const already = (list.steps||[]).find((s:any)=> s.title?.toLowerCase().includes("connect with client") && s.title?.toLowerCase().includes("linkedin"));
  let added:any = { skipped: "already exists", existing: already };
  if (!already) added = await runTool("onboarding_add_template_step", { title: "Ask team to connect with client(s) on Linkedin and share company page", group: "Least Urgent", section: "Communication" });
  return NextResponse.json({ groups: list.groups, sections: list.sections, added });
}
