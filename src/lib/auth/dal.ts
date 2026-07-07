// Server-side session access for server components, layouts, and route handlers.
// Imports next/headers, so this must NEVER be imported by the Proxy (which reads
// the cookie off the NextRequest instead — see src/proxy.ts).

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifyPayload, type SessionPayload } from "./session";

/** The current user's session, or null if unauthenticated. */
export async function getSession(): Promise<SessionPayload | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return verifyPayload<SessionPayload>(token);
}

/**
 * Require a session; redirects to /login if there isn't one. Use this as the
 * defense-in-depth check inside protected server components / route handlers
 * (the Proxy is only an optimistic first line — see the Next.js auth guide).
 */
export async function requireSession(): Promise<SessionPayload> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}
