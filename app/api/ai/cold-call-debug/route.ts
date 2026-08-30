import { NextResponse } from "next/server";
import { saveCallScript, getCallScript, getCallList } from "../../../lib/cold-calling";
export const maxDuration = 60;
export async function GET() {
  // round-trip the script for steadywell
  const save = await saveCallScript("steadywell", "TEST SCRIPT — hello {{name}}");
  const list = await getCallList("steadywell");
  const wsId = "8ec56523-7157-4968-8ed7-e50bfa618f3f";
  const readBack = await getCallScript(wsId);
  return NextResponse.json({ save, scriptInList: list.client?.script, readBack });
}
