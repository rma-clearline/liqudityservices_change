import { NextResponse } from "next/server";
import { getBaseUrl } from "@/lib/auth/config";
import { clearedCookieOptions, SESSION_COOKIE } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

// POST from the "Sign out" form. 303 so the browser follows with a GET to /login.
export async function POST(request: Request) {
  const res = NextResponse.redirect(new URL("/login?signedout=1", getBaseUrl(request)), { status: 303 });
  res.cookies.set(SESSION_COOKIE, "", clearedCookieOptions());
  return res;
}
