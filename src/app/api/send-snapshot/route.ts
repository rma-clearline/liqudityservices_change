import { NextResponse } from "next/server";
import { Resend } from "resend";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Guardrails for a public POST endpoint that sends email + accepts an image.
const MAX_BODY_BYTES = 8_000_000; // ~8MB request cap
const MAX_CHART_BASE64 = 6_000_000; // ~4.5MB decoded PNG
const RATE_LIMIT_MAX = 5; // requests
const RATE_LIMIT_WINDOW_MS = 10 * 60_000; // per 10 minutes, per client

// Best-effort in-memory limiter. Per serverless instance, but enough to blunt
// abuse of an unauthenticated endpoint; a shared store can replace it later.
const rateBuckets = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(key) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(key, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return false;
}

function clientKey(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return (fwd?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown").slice(0, 64);
}

function configuredSnapshotRecipients() {
  return new Set(
    (process.env.NOTIFICATION_EMAIL ?? "")
      .split(",")
      .map((recipient) => recipient.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function POST(request: Request) {
  if (rateLimited(clientKey(request))) {
    return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const { email, chartImage } = await request.json();

  if (typeof chartImage === "string" && chartImage.length > MAX_CHART_BASE64) {
    return NextResponse.json({ error: "Chart image too large" }, { status: 413 });
  }

  const allowedRecipients = configuredSnapshotRecipients();

  if (allowedRecipients.size === 0) {
    return NextResponse.json({ error: "Snapshot recipients are not configured" }, { status: 500 });
  }

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  const requestedEmail = email.trim().toLowerCase();
  if (!allowedRecipients.has(requestedEmail)) {
    return NextResponse.json({ error: "Email recipient is not allowed" }, { status: 403 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Email not configured on server" }, { status: 500 });
  }

  const { data: rows } = await supabase
    .from("listings")
    .select("*")
    .order("date", { ascending: false })
    .order("timestamp", { ascending: false })
    .limit(30);

  const latest = rows?.[0];
  const fmtNum = (n: number | null) => (n != null ? n.toLocaleString("en-US") : "N/A");

  const tableRows = (rows ?? [])
    .map(
      (r) =>
        `<tr>
          <td style="padding:4px 12px 4px 0;border-bottom:1px solid #eee;">${r.date}</td>
          <td style="padding:4px 12px 4px 0;border-bottom:1px solid #eee;text-align:right;">${fmtNum(r.allsurplus)}</td>
          <td style="padding:4px 0;border-bottom:1px solid #eee;text-align:right;">${fmtNum(r.govdeals)}</td>
        </tr>`,
    )
    .join("");

  const attachments: { filename: string; content: string; content_type: string; contentId: string }[] = [];
  let chartHtml = "";
  if (chartImage && typeof chartImage === "string" && chartImage.startsWith("data:image/")) {
    const base64 = chartImage.split(",")[1];
    attachments.push({
      filename: "chart.png",
      content: base64,
      content_type: "image/png",
      contentId: "chart_img",
    });
    chartHtml = `<img src="cid:chart_img" style="width:100%;max-width:900px;margin:16px 0;" alt="Listings Chart" />`;
  }

  const resend = new Resend(apiKey);
  const { error } = await resend.emails.send({
    from: process.env.RESEND_FROM_EMAIL || "LQDT Tracker <notifications@resend.dev>",
    to: [requestedEmail],
    subject: `LQDT Listings Snapshot — ${latest?.date ?? "Latest"}`,
    attachments,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:900px;">
        <h2 style="margin-bottom:4px;">LQDT Listings Snapshot</h2>
        <p style="color:#666;margin-top:0;">${latest ? `${latest.date} ${latest.timestamp} ET` : ""}</p>
        ${latest ? `
        <table style="margin-bottom:16px;">
          <tr>
            <td style="padding-right:24px;"><strong>AllSurplus:</strong> ${fmtNum(latest.allsurplus)}</td>
            <td><strong>GovDeals:</strong> ${fmtNum(latest.govdeals)}</td>
          </tr>
        </table>
        ` : ""}
        ${chartHtml}
        <h3 style="margin-top:24px;">Last 30 Days</h3>
        <table style="border-collapse:collapse;font-size:14px;">
          <tr style="border-bottom:2px solid #333;">
            <th style="padding:4px 12px 4px 0;text-align:left;">Date</th>
            <th style="padding:4px 12px 4px 0;text-align:right;">AllSurplus</th>
            <th style="padding:4px 0;text-align:right;">GovDeals</th>
          </tr>
          ${tableRows}
        </table>
      </div>
    `,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
