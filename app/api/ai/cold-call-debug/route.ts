import { NextResponse } from "next/server";
import { runTool } from "../../../lib/assistant-tools";
export const maxDuration = 60;
export async function GET() {
  const out: Record<string, unknown> = {};
  try { out.create = await runTool("create_project", { client: "steadywell", title: "TEST — verify bot can add projects", stage: "in_progress", assignee: "Kiril" }); } catch(e){ out.createErr = String(e); }
  try { const l = await runTool("list_projects", { client: "steadywell" }) as any; out.listTotal = l.total; out.inProgress = l.byStage?.["In progress"]?.map((p:any)=>({id:p.id,title:p.title,assignee:p.assignee})); } catch(e){ out.listErr = String(e); }
  return NextResponse.json(out);
}
