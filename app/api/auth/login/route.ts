// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { NextResponse } from "next/server";
import { AUTH_COOKIE, SESSION_MAX_AGE, cookieDomain, isValidPassword, sessionToken } from "../../../lib/auth";

/**
 * Trades the shared password (or the private recovery code) for the session cookie.
 *
 * A wrong password waits a fixed moment before answering. It is not a real defence against a determined
 * attacker, but it makes online guessing of a single password slow enough to be pointless while costing a
 * correct login nothing. The cookie is httpOnly so page scripts cannot read it, Secure in production so it
 * is never sent in the clear, and scoped to the whole domain so this one login covers every subdomain.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { password?: unknown };
  if (!isValidPassword(body?.password)) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    return NextResponse.json({ ok: false, error: "That password is not right." }, { status: 401 });
  }
  const token = await sessionToken();
  const domain = cookieDomain(request.headers.get("host") ?? "");
  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    ...(domain ? { domain } : {}),
  });
  return response;
}
