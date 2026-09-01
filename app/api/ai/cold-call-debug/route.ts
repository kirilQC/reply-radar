import { NextResponse } from "next/server";
import { listTemplate } from "../../../lib/onboarding";
export const maxDuration = 30;
export async function GET() {
  const steps = await listTemplate();
  const sections = Array.from(new Set(steps.map((s:any)=>s.section).filter(Boolean)));
  const groups = Array.from(new Set(steps.map((s:any)=>s.group).filter(Boolean)));
  return NextResponse.json({ count: steps.length, sections, groups, sample: steps.slice(0,3).map((s:any)=>({title:s.title,section:s.section,group:s.group})) });
}
