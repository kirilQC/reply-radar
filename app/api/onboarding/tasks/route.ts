// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { setTaskDone } from "../../../lib/onboarding";

// Check a checklist item off (or back on). The Slack post and the complete/reopen flip happen server-side
// in setTaskDone; the response carries the recomputed progress so the page's bar matches the source of truth.
export async function PATCH(request: Request) {
  const payload = await request.json().catch(() => ({}));
  const result = await setTaskDone({
    taskId: String(payload?.taskId ?? ""),
    isDone: Boolean(payload?.isDone),
    doneBy: payload?.doneBy,
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, progress: result.progress });
}
