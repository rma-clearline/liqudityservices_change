// Central config + helpers for the Microsoft Entra ID (Azure AD) sign-in layer.
//
// Every secret is read from the environment LAZILY (inside functions) so that
// merely importing this module never throws during `next build` — the real
// values are injected at runtime by Azure Container Apps.

/** The only email domain allowed to sign in. Override with AUTH_ALLOWED_DOMAIN. */
export function allowedDomain(): string {
  return (process.env.AUTH_ALLOWED_DOMAIN || "clearlinecap.com").trim().toLowerCase();
}

/** True only for a well-formed address whose domain matches the allow-list. */
export function isAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return false;
  return email.slice(at + 1).trim().toLowerCase() === allowedDomain();
}

export type EntraConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  jwksUrl: string;
  issuer: string;
};

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(s: string): boolean {
  return GUID_RE.test(s);
}

export function entraConfig(): EntraConfig {
  const tenantId = required("ENTRA_TENANT_ID");
  const clientId = required("ENTRA_CLIENT_ID");
  const clientSecret = required("ENTRA_CLIENT_SECRET");
  const base = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}`;
  return {
    tenantId,
    clientId,
    clientSecret,
    authorizeUrl: `${base}/oauth2/v2.0/authorize`,
    tokenUrl: `${base}/oauth2/v2.0/token`,
    jwksUrl: `${base}/discovery/v2.0/keys`,
    // v2.0 issuer embeds the tenant GUID. Only strictly checked when tenantId is
    // a GUID (see verifyIdToken in entra.ts).
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  };
}

/** Redirect URI path registered in the Entra app registration. */
export const CALLBACK_PATH = "/api/auth/callback";

/**
 * Public base URL of the app, used to build the OAuth redirect_uri and to build
 * absolute redirect targets from route handlers. Prefer the explicit
 * AUTH_BASE_URL (set this in production so it EXACTLY matches the redirect URI
 * registered in Entra); otherwise derive it from the forwarded headers set by
 * the Container Apps ingress (and the dev server).
 */
export function getBaseUrl(req: Request): string {
  const configured = process.env.AUTH_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const h = req.headers;
  const proto = h.get("x-forwarded-proto")?.split(",")[0].trim() || "https";
  const host =
    h.get("x-forwarded-host")?.split(",")[0].trim() || h.get("host") || "localhost:3000";
  return `${proto}://${host}`;
}

export function redirectUri(req: Request): string {
  return `${getBaseUrl(req)}${CALLBACK_PATH}`;
}
