// Microsoft Entra ID (Azure AD) OpenID Connect authorization-code flow (PKCE).
//
// Everything uses Web Crypto + fetch, so it runs on the Node runtime with no
// external dependencies. The id_token is both (a) obtained directly from the
// token endpoint over TLS AND (b) signature-verified against the tenant JWKS,
// then all claims are validated.

import { entraConfig, isGuid, redirectUri } from "./config";
import { b64urlEncode, b64urlToBytes, b64urlToString } from "./encoding";

const SCOPE = "openid profile email";

// --- random + PKCE helpers ---

export function randomToken(bytes = 32): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return b64urlEncode(arr);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64urlEncode(new Uint8Array(digest));
}

// --- authorize + token exchange ---

export function buildAuthorizeUrl(opts: {
  req: Request;
  state: string;
  nonce: string;
  codeChallenge: string;
}): string {
  const cfg = entraConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: redirectUri(opts.req),
    response_mode: "query",
    scope: SCOPE,
    state: opts.state,
    nonce: opts.nonce,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    // Let a wrong-domain user pick a different account instead of being stuck.
    prompt: "select_account",
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

type TokenResponse = {
  id_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
};

export async function exchangeCodeForIdToken(opts: {
  req: Request;
  code: string;
  codeVerifier: string;
}): Promise<string> {
  const cfg = entraConfig();
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: redirectUri(opts.req),
    code_verifier: opts.codeVerifier,
    scope: SCOPE,
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || json.error || !json.id_token) {
    throw new Error(`Token exchange failed: ${json.error ?? res.status} ${json.error_description ?? ""}`.trim());
  }
  return json.id_token;
}

// --- id_token verification ---

export type IdTokenClaims = {
  oid?: string;
  sub?: string;
  tid?: string;
  email?: string;
  preferred_username?: string;
  upn?: string;
  name?: string;
  aud?: string;
  iss?: string;
  exp?: number;
  nbf?: number;
  nonce?: string;
};

type JwkWithKid = JsonWebKey & { kid?: string };

// Best-effort module-scoped JWKS cache. Microsoft rotates signing keys, so refetch
// on a cache miss (unknown kid) as well as on TTL expiry.
let jwksCache: { keys: JwkWithKid[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function fetchJwks(): Promise<JwkWithKid[]> {
  const cfg = entraConfig();
  const res = await fetch(cfg.jwksUrl, { cache: "no-store" });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const data = (await res.json()) as { keys: JwkWithKid[] };
  jwksCache = { keys: data.keys, fetchedAt: Date.now() };
  return data.keys;
}

async function findSigningKey(kid: string | undefined): Promise<JwkWithKid> {
  const fresh = jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS;
  let keys = fresh ? jwksCache!.keys : await fetchJwks();
  let jwk = keys.find((k) => k.kid === kid);
  if (!jwk && fresh) {
    // Cached but kid unknown → keys may have rotated; refetch once.
    keys = await fetchJwks();
    jwk = keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error("No matching JWKS key for id_token");
  return jwk;
}

/**
 * Verify the id_token's RS256 signature against the tenant JWKS and validate its
 * claims (aud, iss/tid, exp/nbf, nonce). Returns the claims on success; throws
 * otherwise. Does NOT check the email domain — the caller does that.
 */
export async function verifyIdToken(idToken: string, expectedNonce: string): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = JSON.parse(b64urlToString(headerB64)) as { alg?: string; kid?: string };
  if (header.alg !== "RS256") throw new Error(`Unexpected id_token alg: ${header.alg}`);

  const jwk = await findSigningKey(header.kid);
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e }, // minimal JWK to avoid strict-field rejections
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) throw new Error("id_token signature verification failed");

  const claims = JSON.parse(b64urlToString(payloadB64)) as IdTokenClaims;
  const cfg = entraConfig();
  const now = Math.floor(Date.now() / 1000);
  const SKEW = 60; // seconds

  if (claims.aud !== cfg.clientId) throw new Error("id_token aud mismatch");
  if (typeof claims.exp === "number" && claims.exp < now - SKEW) throw new Error("id_token expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + SKEW) throw new Error("id_token not yet valid");
  if (claims.nonce !== expectedNonce) throw new Error("id_token nonce mismatch");
  if (!claims.iss?.startsWith("https://login.microsoftonline.com/")) {
    throw new Error("id_token issuer mismatch");
  }
  // Single-tenant hardening: when the tenant is configured as a GUID we can pin
  // both the issuer and the tenant claim. When it's a domain/"organizations",
  // the single-tenant authority URL already scopes sign-in; the email-domain
  // check (caller) is the backstop.
  if (isGuid(cfg.tenantId)) {
    if (claims.iss !== cfg.issuer) throw new Error("id_token issuer/tenant mismatch");
    if (claims.tid && claims.tid !== cfg.tenantId) throw new Error("id_token tenant mismatch");
  }
  return claims;
}

/** Resolve the user's email from the claims Entra actually populates. */
export function emailFromClaims(claims: IdTokenClaims): string {
  return (claims.email || claims.preferred_username || claims.upn || "").trim().toLowerCase();
}
