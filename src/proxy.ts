// Auth gate. In Next.js 16 this file replaces `middleware.ts` (same behavior,
// runs on the Node.js runtime). It performs an OPTIMISTIC check — it only reads
// and verifies the signed session cookie, never touches a DB. Protected server
// components / route handlers still verify via the DAL (see src/lib/auth/dal.ts).

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifyPayload, type SessionPayload } from "@/lib/auth/session";

// Reachable without a user session.
const PUBLIC_PATHS = new Set(["/login"]);
const PUBLIC_PREFIXES = ["/api/auth/"];

// Machine-to-machine endpoints that authenticate with their OWN secret
// (CRON_SECRET). Gating these behind the SSO session would break the scheduled
// cron ingestion and the sold-lot backfill, so they bypass the gate here and
// keep enforcing their own auth inside the handler.
const MACHINE_PREFIXES = ["/api/cron", "/api/backfill-sold"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const isPublic =
    PUBLIC_PATHS.has(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)) ||
    MACHINE_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (isPublic) return NextResponse.next();

  const session = await verifyPayload<SessionPayload>(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  // Unauthenticated. Data/API calls get a clean 401 (a redirect to an HTML login
  // page would just confuse fetch()); page navigations go to /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const loginUrl = req.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  loginUrl.searchParams.set("returnTo", pathname + (req.nextUrl.search || ""));
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Run on everything except Next internals and static assets.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
