# Authentication setup (Microsoft Entra ID SSO)

The app is gated by a "Sign in with Microsoft" screen. Only **@clearlinecap.com**
accounts can complete sign-in and use the app. This doc is the one-time setup.

## How it works

- `src/proxy.ts` (Next.js 16 replacement for middleware) checks a signed session
  cookie on every request. No session → redirect to `/login` (pages) or `401`
  (API). Cron endpoints (`/api/cron`, `/api/backfill-sold`) bypass the gate and
  keep using `CRON_SECRET`.
- `/login` → `Continue with Microsoft` → `/api/auth/login` starts an OpenID
  Connect **authorization-code flow with PKCE** against your Entra tenant.
- `/api/auth/callback` verifies the returned `id_token` (RS256 signature against
  the tenant JWKS + `aud`/`iss`/`tid`/`nonce`/expiry checks), enforces the
  `@clearlinecap.com` rule, then sets an HMAC-signed, httpOnly session cookie
  (7-day lifetime). `/api/auth/logout` clears it.
- No new npm dependencies — signing/verification use the built-in Web Crypto API.

## 1. Register the app in Azure

Azure Portal → **Microsoft Entra ID** → **App registrations** → **New registration**:

- **Name:** `LQDT Analytics`
- **Supported account types:** *Accounts in this organizational directory only
  (Clearline — Single tenant)*
- **Redirect URI:** platform **Web**, value:
  - Production: `https://<your-app-host>/api/auth/callback`
  - Local dev (add a second Web redirect URI): `http://localhost:3000/api/auth/callback`

After creating it, from the **Overview** page copy:
- **Application (client) ID** → `ENTRA_CLIENT_ID`
- **Directory (tenant) ID** → `ENTRA_TENANT_ID`

Then **Certificates & secrets** → **New client secret** → copy the secret **Value**
(not the ID) → `ENTRA_CLIENT_SECRET`. Note its expiry and set a calendar reminder
to rotate it.

API permissions: the default delegated **Microsoft Graph → User.Read** (with
`openid`, `profile`, `email`) is sufficient. No admin consent needed.

## 2. Set environment variables

| Variable | Value |
| --- | --- |
| `ENTRA_TENANT_ID` | Directory (tenant) ID (GUID) |
| `ENTRA_CLIENT_ID` | Application (client) ID |
| `ENTRA_CLIENT_SECRET` | Client secret **value** |
| `AUTH_SECRET` | `openssl rand -base64 32` — signs the session cookie |
| `AUTH_ALLOWED_DOMAIN` | `clearlinecap.com` (default if unset) |
| `AUTH_BASE_URL` | Prod only: full public URL, e.g. `https://<your-app-host>` |

- **Local dev:** put these in `.env.local`. Leave `AUTH_BASE_URL` unset (it's
  derived from the request host).
- **Azure Container Apps:** add all of the above as **secrets / env vars** on the
  container app. Set `AUTH_BASE_URL` to the app's real URL so the `redirect_uri`
  sent to Microsoft exactly matches the one you registered.

> `AUTH_SECRET` must be the same across all running replicas, and changing it
> invalidates everyone's existing sessions (forces re-login).

## 3. Verify

1. Visit the app → you should be redirected to `/login`.
2. `Continue with Microsoft` → sign in with a `@clearlinecap.com` account → you
   land back in the dashboard, with your email + a **Sign out** button in the header.
3. Try a non-Clearline account (e.g. a personal Microsoft account) → you're
   bounced back to `/login` with an "isn't a @clearlinecap.com address" message.
