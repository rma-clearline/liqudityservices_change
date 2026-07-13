import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifyPayload, type SessionPayload } from "@/lib/auth/session";
import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Analyst override for a quarter's company guidance / Clearline estimate (the
// QTD page's edit panel). Upserts into `model_estimates` (service-role only —
// no public policy), which overrides the model-workbook export for that quarter.
// `clear: true` deletes the override, reverting to the model-file values.
//
// The proxy already gates /api/* behind the Entra session; the cookie is decoded
// here again to attribute the change (updated_by) and as defense in depth.

const QUARTER_RE = /^\d{4}Q[1-4]$/;

function parseUsd(v: unknown): number | null | "invalid" {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 100e9) return "invalid";
  return Math.round(n);
}

export async function POST(request: NextRequest) {
  const session = await verifyPayload<SessionPayload>(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.email) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const quarter = typeof body.quarter === "string" ? body.quarter.trim() : "";
  if (!QUARTER_RE.test(quarter)) {
    return NextResponse.json({ error: 'Invalid quarter — expected "YYYYQn".' }, { status: 400 });
  }

  if (body.clear === true) {
    const res = await supabaseAdmin.from("model_estimates").delete().eq("quarter", quarter);
    if (res.error) return dbError(res.error.message);
    return NextResponse.json({ quarter, cleared: true });
  }

  const low = parseUsd(body.guidance_low_usd);
  const high = parseUsd(body.guidance_high_usd);
  const cl = parseUsd(body.clearline_estimate_usd);
  if (low === "invalid" || high === "invalid" || cl === "invalid") {
    return NextResponse.json({ error: "Values must be positive dollar amounts." }, { status: 400 });
  }
  if ((low == null) !== (high == null)) {
    return NextResponse.json({ error: "Provide both guidance low and high (or neither)." }, { status: 400 });
  }
  if (low != null && high != null && low > high) {
    return NextResponse.json({ error: "Guidance low must not exceed high." }, { status: 400 });
  }
  if (low == null && cl == null) {
    return NextResponse.json({ error: "Provide guidance and/or a Clearline estimate." }, { status: 400 });
  }

  const row = {
    quarter,
    guidance_low_usd: low,
    guidance_high_usd: high,
    clearline_estimate_usd: cl,
    updated_by: session.email,
    updated_at: new Date().toISOString(),
  };
  const res = await supabaseAdmin.from("model_estimates").upsert(row, { onConflict: "quarter" });
  if (res.error) return dbError(res.error.message);
  return NextResponse.json({ ...row, source: "manual" });
}

function dbError(message: string) {
  const missing = /relation .*model_estimates.* does not exist|schema cache/i.test(message);
  return NextResponse.json(
    {
      error: missing
        ? "The model_estimates table doesn't exist yet — apply supabase/migrations/029_model_estimates.sql."
        : `Save failed: ${message}`,
    },
    { status: missing ? 503 : 502 },
  );
}
