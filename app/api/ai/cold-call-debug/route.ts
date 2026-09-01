import { NextResponse } from "next/server";
import { listColdCallClients } from "../../../lib/cold-calling";
import { listOnboardingClients } from "../../../lib/onboarding";
export const maxDuration = 30;
export async function GET() {
  const cc = await listColdCallClients();
  const onb = await listOnboardingClients();
  return NextResponse.json({
    miscInColdCalling: cc.some((c) => c.slug === "misc"),
    miscInOnboarding: onb.some((c) => c.slug === "misc"),
    coldCallingCount: cc.length, onboardingCount: onb.length,
  });
}
