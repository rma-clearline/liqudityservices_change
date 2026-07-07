import { NextResponse } from "next/server";
import { buildAuthorizeUrl, pkceChallenge, randomToken } from "@/lib/auth/entra";
import { getBaseUrl } from "@/lib/auth/config";
import { signPayload, TX_COOKIE, TX_TTL_SECONDS, txCookieOptions } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

// Starts the sign-in: mints state/nonce/PKCE, stashes them in a short-lived
// signed cookie, and redirects to Microsoft's authorize endpoint.
export async function GET(request: Request) {
  const base = getBaseUrl(request);
  try {
    const returnTo = sanitizeReturnTo(new URL(request.url).searchParams.get("returnTo"));
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken(48);
    const codeChallenge = await pkceChallenge(codeVerifier);

    const authorizeUrl = buildAuthorizeUrl({ req: request, state, nonce, codeChallenge });
    const tx = await signPayload({ state, nonce, codeVerifier, returnTo }, TX_TTL_SECONDS);

    const res = NextResponse.redirect(authorizeUrl);
    res.cookies.set(TX_COOKIE, tx, txCookieOptions());
    return res;
  } catch (e) {
    console.error("[auth] login init failed:", e);
    return NextResponse.redirect(new URL("/login?error=config", base));
  }
}

// Only allow same-origin absolute paths as the post-login destination — blocks
// open-redirect abuse via ?returnTo=https://evil.example.
function sanitizeReturnTo(v: string | null): string {
  if (!v || !v.startsWith("/") || v.startsWith("//")) return "/";
  return v;
}
