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
# present here (passed as build-args by the CI). Server-only secrets are injected
# at runtime by Container Apps and must NOT be baked in.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_TELEMETRY_DISABLED=1
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
