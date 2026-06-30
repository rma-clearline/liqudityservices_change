"use client";

import { useState } from "react";

export function EmailSnapshot({ chartRef }: { chartRef: React.RefObject<HTMLDivElement | null> }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState("");

  async function handleSend() {
    if (!email.includes("@")) {
      setStatus("error");
      setMessage("Please enter a valid email address.");
      return;
    }

    setStatus("sending");
    setMessage("");

    let chartImage: string | null = null;
    if (chartRef.current) {
      try {
        const html2canvas = (await import("html2canvas-pro")).default;
        const canvas = await html2canvas(chartRef.current, {
          backgroundColor: "#ffffff",
          scale: 2,
        });
        chartImage = canvas.toDataURL("image/png");
      } catch {
        // proceed without chart image
      }
    }

    try {
      const res = await fetch("/api/send-snapshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, chartImage }),
      });

      const data = await res.json();
      if (res.ok) {
        setStatus("sent");
        setMessage("Snapshot sent!");
        setEmail("");
      } else {
        setStatus("error");
        setMessage(data.error || "Failed to send.");
      }
    } catch {
      setStatus("error");
      setMessage("Network error. Try again.");
    }
  }

  return (
    <div className="flex items-center gap-3 mb-8">
      <input
        type="email"
        value={email}
        onChange={(e) => { setEmail(e.target.value); setStatus("idle"); }}
        placeholder="you@example.com"
        className="border rounded-md px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
      <button
        onClick={handleSend}
        disabled={status === "sending"}
        className="px-4 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {status === "sending" ? "Sending..." : "Send"}
      </button>
      {message && (
        <span className={`text-sm ${status === "error" ? "text-red-500" : "text-green-600"}`}>
          {message}
        </span>
      )}
    </div>
  );
}
