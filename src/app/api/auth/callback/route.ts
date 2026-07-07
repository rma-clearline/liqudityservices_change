import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { emailFromClaims, exchangeCodeForIdToken, verifyIdToken } from "@/lib/auth/entra";
import { getBaseUrl, isAllowedEmail } from "@/lib/auth/config";
import {
  clearedCookieOptions,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  sessionCookieOptions,
  signPayload,
  TX_COOKIE,
  verifyPayload,
  type SessionPayload,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

type Tx = { state: string; nonce: string; codeVerifier: string; returnTo: string };

// Handles Microsoft's redirect back: validates state, exchanges the code,
// verifies the id_token, enforces the @clearlinecap.com rule, and mints our
// session cookie.
export async function GET(request: Request) {
  const base = getBaseUrl(request);
  const url = new URL(request.url);

  const fail = (error: string) => {
    const res = NextResponse.redirect(new URL(`/login?error=${error}`, base));
    res.cookies.set(TX_COOKIE, "", clearedCookieOptions());
    return res;
  };

  // The user cancelled or Entra returned an error on the authorize step.
  const oauthError = url.searchParams.get("error");
  if (oauthError) return fail(oauthError === "access_denied" ? "cancelled" : "oauth");

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return fail("oauth");

  const jar = await cookies();
  const tx = await verifyPayload<Tx>(jar.get(TX_COOKIE)?.value);
  if (!tx || tx.state !== state) return fail("session");

  let email: string;
  let session: SessionPayload;
  try {
    const idToken = await exchangeCodeForIdToken({ req: request, code, codeVerifier: tx.codeVerifier });
    const claims = await verifyIdToken(idToken, tx.nonce);
    email = emailFromClaims(claims);
    session = {
      sub: claims.oid || claims.sub || email,
      email,
      name: claims.name,
      tid: claims.tid,
    };
  } catch (e) {
    console.error("[auth] callback verification failed:", e);
    return fail(String(e).includes("environment variable") ? "config" : "oauth");
  }

  // The domain gate: this is what enforces "only @clearlinecap.com can use the app".
  if (!isAllowedEmail(email)) return fail("domain");

  const token = await signPayload(session, SESSION_TTL_SECONDS);
  const returnTo = tx.returnTo?.startsWith("/") && !tx.returnTo.startsWith("//") ? tx.returnTo : "/";

  const res = NextResponse.redirect(new URL(returnTo, base));
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
  res.cookies.set(TX_COOKIE, "", clearedCookieOptions());
  return res;
}
