import { NextResponse } from "next/server";
import { Resend } from "resend";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function configuredSnapshotRecipients() {
  return new Set(
    (process.env.NOTIFICATION_EMAIL ?? "")
      .split(",")
      .map((recipient) => recipient.trim().toLowerCase())
      .filter(Boolean),
  );
}

export async function POST(request: Request) {
  const { email, chartImage } = await request.json();
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
