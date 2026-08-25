// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The inbound DNC webhook — Clay's side of the two-way sync.
 *
 * Clay exposes no API we can pull from, so instead each client's Clay DNC table POSTs its rows here (Clay's
 * "HTTP API" action, one request per row). That keeps Reply Radar's mirror a true reflection of the real Clay
 * table: the domains Clay enriched, and any company added straight in Clay, all flow back in. Routed by a
 * static `client` field in the payload (name the client), plus `company` and optionally `domain`.
 *
 * One URL for every client, like the meetings webhook. If DNC_WEBHOOK_SECRET is set it must be provided (as
 * `?secret=` or an `x-webhook-secret` header); if not, the post is accepted as-is so it works the moment the
 * URL is pasted into Clay. This route sits under /api/webhooks, which the auth gate leaves open for machines.
 */
import { NextResponse, after } from "next/server";
import { ingestDncFromClay, syncDncToBrain } from "../../../lib/dnc";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export async function POST(request: Request) {
  const secret = (process.env.DNC_WEBHOOK_SECRET ?? "").trim();
  if (secret) {
    const provided = new URL(request.url).searchParams.get("secret") ?? request.headers.get("x-webhook-secret") ?? "";
    if (!timingSafeEqual(provided, secret)) {
      return NextResponse.json({ ok: false, error: "Wrong or missing webhook secret." }, { status: 401 });
    }
  }
  const payload = await request.json().catch(() => null);
  if (!payload || typeof payload !== "object") {
    return NextResponse.json({ ok: false, error: "Send a JSON body with a client field and a company." }, { status: 400 });
  }
  const result = await ingestDncFromClay(payload);
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
  // Refresh the client's brain DNC file after the 200, so Clay's per-row POSTs stay fast. The file is only
  // re-committed when its contents actually changed, so a re-sent row does not create an empty commit.
  if (result.workspaceId && result.client) {
    const wid = result.workspaceId;
    const name = result.client;
    after(() => syncDncToBrain(wid, name).catch(() => {}));
  }
  return NextResponse.json({ ok: true, client: result.client, company: result.company });
}
