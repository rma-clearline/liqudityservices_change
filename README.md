# LQDT Listings Tracker

Daily scraper and dashboard for Liquidity Services marketplace active listing counts (AllSurplus + GovDeals).

## Stack

- **Next.js** (App Router) — dashboard UI + API routes
- **Supabase** — PostgreSQL database for historical data
- **Vercel Cron** — scheduled daily scrape at 6 PM UTC
- **Maestro API** — direct API calls to Liquidity Services search backend (no headless browser needed)
- **Resend** — optional email notifications after each scrape
- **Recharts** — trend chart on dashboard

## Setup

### 1. Supabase

Create a Supabase project and run the migration in `supabase/migrations/001_create_listings_table.sql` via the SQL Editor.

### 2. Environment Variables

Copy `.env.local.example` to `.env.local` and fill in your values. On Vercel, set these in the project's Environment Variables settings.

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SECRET_KEY` | Yes | Supabase secret key (`sb_secret_...`), server-only — never use a `NEXT_PUBLIC_` name for this |
| `CRON_SECRET` | Yes | Secret for authenticating cron requests |
| `MAESTRO_API_URL` | No | Maestro API base URL (defaults to `https://maestro.lqdt1.com`) |
| `MAESTRO_API_KEY` | No | Maestro API key (defaults to public key from LS frontend) |
| `RESEND_API_KEY` | No | Resend API key for email notifications |
| `RESEND_FROM_EMAIL` | No | Sender address for emails |
| `NOTIFICATION_EMAIL` | No | Comma-separated recipient emails |

**Important:** On Vercel, also set `CRON_SECRET` as the value for the built-in `CRON_SECRET` environment variable so Vercel automatically passes it as a Bearer token to cron endpoints.

### 3. Deploy

```bash
npm install
npm run dev     # local development
vercel deploy   # deploy to Vercel
```

### 4. Manual Trigger

To test the cron job manually:

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" https://your-app.vercel.app/api/cron
```

## Architecture

```
/api/cron     — Vercel cron handler: scrapes both sites, inserts row into Supabase, sends email
/api/listings — REST endpoint returning historical data as JSON
/             — Dashboard page with stats cards, trend chart, and history table
```
