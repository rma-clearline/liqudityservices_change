// Stateless session token: a compact HMAC-SHA256 signed token
// (base64url(payload).base64url(signature)) stored in an httpOnly cookie.
//
// Signed and verified with the Web Crypto API so the exact same code runs in the
// Node runtime (route handlers, server components) and in the Proxy. No external
// dependencies.

import { b64urlEncode, b64urlToBytes, b64urlToString } from "./encoding";

/** Signed cookie holding the logged-in user's session. */
export const SESSION_COOKIE = "lqdt_session";
/** Short-lived signed cookie holding the in-flight OAuth transaction (state/nonce/PKCE). */
export const TX_COOKIE = "lqdt_auth_tx";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
export const TX_TTL_SECONDS = 60 * 10; // 10 minutes to complete sign-in

/** What we persist about a signed-in user. Kept minimal (no PII beyond email). */
export type SessionPayload = {
  sub: string; // Entra object id (oid)
  email: string;
  name?: string;
  tid?: string; // tenant id
};

function authSecret(): string {
  const s = process.env.AUTH_SECRET?.trim();
  if (!s) throw new Error("Missing required environment variable: AUTH_SECRET");
  return s;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(data: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Sign an arbitrary JSON payload into a self-expiring token. The expiry lives in
 * a wrapper so callers don't have to thread iat/exp through their own types.
 */
export async function signPayload(data: unknown, ttlSeconds: number): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const body = b64urlEncode(new TextEncoder().encode(JSON.stringify({ d: data, iat, exp: iat + ttlSeconds })));
  return `${body}.${await sign(body)}`;
}

/** Verify a token; returns the inner payload, or null if invalid/expired. */
export async function verifyPayload<T>(token: string | undefined | null): Promise<T | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);
  let expectedSig: string;
  try {
    expectedSig = await sign(body);
  } catch {
    return null; // e.g. AUTH_SECRET missing
  }
  if (!timingSafeEqual(providedSig, expectedSig)) return null;
  try {
    const wrapped = JSON.parse(b64urlToString(body)) as { d: T; exp: number };
    if (typeof wrapped.exp !== "number" || wrapped.exp < Math.floor(Date.now() / 1000)) return null;
    return wrapped.d;
  } catch {
    return null;
  }
}

// --- cookie option helpers (shared by route handlers + the proxy) ---

export function sessionCookieOptions(maxAgeSeconds = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export function txCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: TX_TTL_SECONDS,
  };
}

/** Options for expiring a cookie immediately (logout / clearing the tx cookie). */
export function clearedCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
}
