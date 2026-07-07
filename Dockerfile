# Multi-stage build for the Next.js 16 app, run on Azure Container Apps.
# Uses `output: "standalone"` (next.config.ts) → a self-contained server.js with
# only the traced node_modules. Builder and runner share the same base image so
# any native deps (e.g. Next's SWC, built during `npm ci`/`build`) stay compatible.

# --- deps: install from the lockfile (cached unless package*.json change) ---
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- builder: compile the standalone server ---
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* are inlined into the client bundle at build time, so they must be
# the REAL values here (passed as build-args by the CI).
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
# Server-only secrets are read at RUNTIME (not inlined) and injected by Container
# Apps. But several modules construct clients at import time (e.g. supabase
# createClient), which runs during `next build`'s page-data collection and throws
# on a missing key. Give those a harmless build-time PLACEHOLDER — never used at
# runtime, never baked into the client bundle (only NEXT_PUBLIC_* are inlined).
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_TELEMETRY_DISABLED=1 \
    SUPABASE_SECRET_KEY=build-placeholder \
    MAESTRO_API_KEY=build-placeholder \
    MAESTRO_API_URL=https://build-placeholder.local \
    CRON_SECRET=build-placeholder \
    RESEND_API_KEY=build-placeholder \
    RESEND_FROM_EMAIL=build@placeholder.local \
    NOTIFICATION_EMAIL=build@placeholder.local \
    SAM_API_KEY=build-placeholder \
    AUTH_SECRET=build-placeholder \
    ENTRA_TENANT_ID=build-placeholder \
    ENTRA_CLIENT_ID=build-placeholder \
    ENTRA_CLIENT_SECRET=build-placeholder
RUN npm run build

# --- runner: minimal production image ---
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

# Standalone server + its traced node_modules (+ the traced scripts/*.csv the
# forecast reads at runtime via process.cwd()).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# server.js serves these from within the standalone dir.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# Belt-and-suspenders: guarantee the runtime-read historical CSVs are present at
# cwd/scripts even if output tracing ever misses a route that needs them.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/*.csv ./scripts/

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
