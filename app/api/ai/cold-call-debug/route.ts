import { NextResponse } from "next/server";
import { runTool } from "../../../lib/assistant-tools";
export const maxDuration = 60;
export async function GET() {
  const del = await runTool("delete_project", { id: "d11d78e5-d9b6-40f7-b3bc-35440aebaf31" });
  return NextResponse.json({ del });
}
