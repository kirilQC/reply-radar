import { NextResponse } from "next/server";
import { saveCallScript } from "../../../lib/cold-calling";
export async function GET() { const r = await saveCallScript("steadywell", ""); return NextResponse.json({ cleared: r }); }
