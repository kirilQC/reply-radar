import { NextResponse } from "next/server";
import { listAssistants, composePersonalBrief } from "../../../lib/personal-brief";
export const maxDuration = 120;
export async function GET() { const p = await listAssistants(); if(!p.length) return NextResponse.json({error:"none"}); const r = await composePersonalBrief(p[0]); return NextResponse.json({ digest: r.digest, error: r.error, hasDoubleStar: (r.digest||"").includes("**") }); }
