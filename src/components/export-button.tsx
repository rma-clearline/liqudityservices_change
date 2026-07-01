"use client";

import { downloadCsv, toCsv } from "@/lib/format";

/** Reusable "Export CSV" button that serializes `rows` using `columns`. */
export function ExportButton<T extends Record<string, unknown>>({
  rows,
  columns,
  filename,
  label = "Export CSV",
}: {
  rows: T[];
  columns: { key: keyof T; label: string }[];
  filename: string;
  label?: string;
}) {
  if (rows.length === 0) return null;
  return (
    <button
      type="button"
      onClick={() => downloadCsv(filename, toCsv(rows, columns))}
      className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50"
    >
      {label}
    </button>
  );
}
