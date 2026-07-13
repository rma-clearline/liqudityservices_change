// Extract LQDT's total REPORTED GMV (quarterly actuals), company guidance, and the
// Clearline model's GMV estimates from the financial model workbook into two small
// LOCAL CSVs the app reads at runtime.
//
// The model workbook (`scripts/LQDT Nums v*.xlsm`) AND the derived CSVs are all
// gitignored — nothing model-derived is ever committed. Prod receives the CSVs as
// Container App secrets via `node scripts/push-model-data.mjs`. Quarterly refresh:
//   node scripts/extract-reported-gmv.mjs && node scripts/push-model-data.mjs
//
// Zero external dependencies: an .xlsm is a ZIP of XML, so we read the ZIP central
// directory and inflate the few parts we need with Node's built-in zlib. We pull
// the "Model" sheet's `Total GMV` row (located by its column-A label, not a fixed
// row number) across the quarterly date-header block, keep only past, integer
// (reported, not model-forecast) quarter-end columns, and convert $000 -> USD.
//
// Optional: --through YYYY-MM-DD  caps the last quarter included (default: any
// quarter that ended at least REPORT_LAG_DAYS ago).

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_CSV = path.join(SCRIPTS_DIR, "reported-gmv-quarterly.csv");
const OUT_ESTIMATES_CSV = path.join(SCRIPTS_DIR, "model-estimates-quarterly.csv");
const REPORT_LAG_DAYS = 35; // a quarter isn't "reported" until ~weeks after it ends

// --- tiny ZIP reader (store + deflate only, which is all xlsx uses) ---------
function readZipEntries(buf) {
  // Find End Of Central Directory (scan backwards for the signature).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a ZIP/xlsx (no EOCD record)");
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // central directory offset
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString("utf8", ptr + 46, ptr + 46 + nameLen);
    entries.set(name, { method, compSize, localOff });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buf, entries, name) {
  const e = entries.get(name);
  if (!e) throw new Error(`ZIP entry not found: ${name}`);
  // Local header has its own name/extra lengths; data follows it.
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const slice = buf.subarray(start, start + e.compSize);
  return (e.method === 0 ? slice : inflateRawSync(slice)).toString("utf8");
}

// --- helpers ----------------------------------------------------------------
const colToIndex = (col) => [...col].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
// Excel serial date -> UTC Date (base 1899-12-30 absorbs the 1900 leap-year bug).
const serialToDate = (serial) => new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
const isQuarterEnd = (d) => {
  const m = d.getUTCMonth() + 1; // 1..12
  if (![3, 6, 9, 12].includes(m)) return false;
  const last = new Date(Date.UTC(d.getUTCFullYear(), m, 0)).getUTCDate();
  return d.getUTCDate() === last;
};
const quarterKey = (d) => `${d.getUTCFullYear()}Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
const ymd = (d) => d.toISOString().slice(0, 10);

/** Cells of one worksheet row, as { [colIndex]: numericValue } (numeric cells only).
 *  Split on cell boundaries so it tolerates formula cells (<f>..</f><v>..</v>) and
 *  self-closing empty cells, which a single `>\s*<v>` pattern would miss/mismatch. */
function numericRowCells(sheetXml, rowNum) {
  const rowRe = new RegExp(`<row[^>]*\\sr="${rowNum}"[^>]*>(.*?)</row>`, "s");
  const rowMatch = rowRe.exec(sheetXml);
  if (!rowMatch) return {};
  const out = {};
  for (const chunk of rowMatch[1].split(/<c\s/).slice(1)) {
    const ref = /^r="([A-Z]+)\d+"/.exec(chunk);
    if (!ref) continue;
    const attrs = chunk.slice(0, chunk.indexOf(">"));
    if (/\st="(s|str|e|b)"/.test(attrs)) continue; // shared-string / formula-string / error / bool
    const v = /<v>([^<]*)<\/v>/.exec(chunk);
    if (!v) continue; // empty / self-closing cell
    const val = Number(v[1]);
    if (Number.isFinite(val)) out[colToIndex(ref[1])] = val;
  }
  return out;
}

/** Cells of one worksheet row, as { [colIndex]: string } — shared-string cells only
 *  (resolved via `sst`). Used for the guidance row, whose values are text ranges
 *  like "425-465" rather than numbers. */
function textRowCells(sheetXml, rowNum, sst) {
  const rowRe = new RegExp(`<row[^>]*\\sr="${rowNum}"[^>]*>(.*?)</row>`, "s");
  const rowMatch = rowRe.exec(sheetXml);
  if (!rowMatch) return {};
  const out = {};
  for (const chunk of rowMatch[1].split(/<c\s/).slice(1)) {
    const ref = /^r="([A-Z]+)\d+"/.exec(chunk);
    if (!ref) continue;
    const attrs = chunk.slice(0, chunk.indexOf(">"));
    if (!/\st="s"/.test(attrs)) continue;
    const v = /<v>([^<]*)<\/v>/.exec(chunk);
    if (!v) continue;
    const s = sst[Number(v[1])];
    if (typeof s === "string" && s.trim()) out[colToIndex(ref[1])] = s.trim();
  }
  return out;
}

/** Parse a guidance string ("425-465", "425 – 465", or a single "450") in $M
 *  into USD { low, high }, or null if it doesn't read as guidance. */
function parseGuidance(s) {
  const range = /^\$?\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*\$?\s*(\d+(?:\.\d+)?)$/i.exec(s);
  if (range) return { low: Math.round(Number(range[1]) * 1e6), high: Math.round(Number(range[2]) * 1e6) };
  const single = /^\$?\s*(\d+(?:\.\d+)?)$/.exec(s);
  if (single) {
    const v = Math.round(Number(single[1]) * 1e6);
    return { low: v, high: v };
  }
  return null;
}

/** Row number whose column-A cell equals `label`. Handles both encodings the
 *  model uses: shared-string labels (t="s") and formula-result labels (t="str"). */
function findLabelRow(sheetXml, sst, label) {
  const idx = sst.findIndex((s) => s.trim() === label);
  if (idx >= 0) {
    const m = new RegExp(`<c\\s+r="A(\\d+)"[^>]*\\st="s"[^>]*>\\s*<v>${idx}</v>`).exec(sheetXml);
    if (m) return Number(m[1]);
  }
  for (const m of sheetXml.matchAll(/<c\s+r="A(\d+)"[^>]*\st="str"[^>]*>(.*?)<\/c>/gs)) {
    const v = /<v>([^<]*)<\/v>/.exec(m[2]);
    if (v && v[1].trim() === label) return Number(m[1]);
  }
  return null;
}

// --- locate the workbook ----------------------------------------------------
function findWorkbook() {
  const cliArg = process.argv.find((a) => a.toLowerCase().endsWith(".xlsm"));
  if (cliArg) return path.isAbsolute(cliArg) ? cliArg : path.join(SCRIPTS_DIR, cliArg);
  const candidates = readdirSync(SCRIPTS_DIR)
    .filter((f) => /^LQDT Nums v.*\.xlsm$/i.test(f))
    .map((f) => ({ f, mtime: statSync(path.join(SCRIPTS_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) throw new Error(`No "LQDT Nums v*.xlsm" found in ${SCRIPTS_DIR}`);
  return path.join(SCRIPTS_DIR, candidates[0].f);
}

function main() {
  const throughArg = process.argv.find((a) => /^--through=/.test(a));
  const through = throughArg ? throughArg.split("=")[1] : null;

  const wbPath = findWorkbook();
  console.log(`Reading workbook: ${path.basename(wbPath)}`);
  const buf = readFileSync(wbPath);
  const entries = readZipEntries(buf);

  // Resolve the "Model" sheet's XML path via workbook.xml + its rels.
  const workbookXml = readEntry(buf, entries, "xl/workbook.xml");
  const relsXml = readEntry(buf, entries, "xl/_rels/workbook.xml.rels");
  const sheetTag = /<sheet[^>]*\bname="Model"[^>]*\/>/i.exec(workbookXml);
  if (!sheetTag) throw new Error('Sheet named "Model" not found in workbook');
  const rId = /r:id="([^"]+)"/.exec(sheetTag[0])?.[1];
  const target = new RegExp(`<Relationship[^>]*\\bId="${rId}"[^>]*\\bTarget="([^"]+)"`).exec(relsXml)?.[1];
  if (!target) throw new Error(`Could not resolve target for ${rId}`);
  const sheetPath = "xl/" + target.replace(/^\/?xl\//, "").replace(/^\//, "");
  const sheetXml = readEntry(buf, entries, sheetPath);

  // Shared strings -> find the row whose column A is "Total GMV".
  const sstXml = readEntry(buf, entries, "xl/sharedStrings.xml");
  const sst = [...sstXml.matchAll(/<si>(.*?)<\/si>/gs)].map((m) =>
    [...m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(""),
  );
  const gmvRow = findLabelRow(sheetXml, sst, "Total GMV");
  if (!gmvRow) throw new Error('Column-A cell "Total GMV" not found in the Model sheet');
  console.log(`Found "Total GMV" at row ${gmvRow}; date header assumed at row 2.`);

  const dateCells = numericRowCells(sheetXml, 2); // colIndex -> Excel serial
  const gmvCells = numericRowCells(sheetXml, gmvRow); // colIndex -> $000

  // Columns that carry both a date header and a GMV value, ordered left->right.
  const cols = Object.keys(dateCells)
    .map(Number)
    .filter((c) => c in gmvCells)
    .sort((a, b) => a - b)
    .map((c) => ({ col: c, date: serialToDate(dateCells[c]), gmv: gmvCells[c] }))
    .filter((x) => isQuarterEnd(x.date));

  // The quarterly block is the longest run of columns stepping ~one quarter each.
  // This isolates it from the lone "as-of" column and the annual (Sep-only) block.
  let best = [];
  for (let i = 0; i < cols.length; i++) {
    const run = [cols[i]];
    for (let j = i + 1; j < cols.length; j++) {
      const days = (cols[j].date - run[run.length - 1].date) / 86400000;
      if (days >= 80 && days <= 100) run.push(cols[j]);
      else break;
    }
    if (run.length > best.length) best = run;
  }

  const now = Date.now();
  const cutoff = through ? Date.parse(through + "T00:00:00Z") : now - REPORT_LAG_DAYS * 86400000;
  const seen = new Set();
  const series = [];
  for (const x of best) {
    // Reported actuals are whole numbers; the model's forecast tail carries decimals.
    if (!Number.isInteger(x.gmv)) continue;
    if (x.date.getTime() > cutoff) continue;
    const key = quarterKey(x.date);
    if (seen.has(key)) continue;
    seen.add(key);
    series.push({ quarter: key, quarter_end: ymd(x.date), reported_gmv_usd: Math.round(x.gmv * 1000) });
  }
  series.sort((a, b) => a.quarter_end.localeCompare(b.quarter_end));

  if (series.length === 0) throw new Error("No reported quarterly actuals extracted — check the sheet layout");

  const csv =
    "quarter,quarter_end,reported_gmv_usd\n" +
    series.map((r) => `${r.quarter},${r.quarter_end},${r.reported_gmv_usd}`).join("\n") +
    "\n";
  writeFileSync(OUT_CSV, csv);

  // --- model estimates: company guidance + the Clearline model's own forecast ---
  // Guidance lives on a text row ("Total GMV Guidance", values like "425-465" in $M);
  // the Clearline estimate is the Total GMV row's decimal-valued (forecast) columns.
  const estimates = new Map(); // quarter -> { quarter_end, low, high, cl }
  const estimate = (x) => {
    const key = quarterKey(x.date);
    let e = estimates.get(key);
    if (!e) {
      e = { quarter: key, quarter_end: ymd(x.date), low: "", high: "", cl: "" };
      estimates.set(key, e);
    }
    return e;
  };
  for (const x of best) {
    if (Number.isInteger(x.gmv)) continue; // integers are reported actuals
    estimate(x).cl = Math.round(x.gmv * 1000);
  }
  const guidanceRow = findLabelRow(sheetXml, sst, "Total GMV Guidance");
  if (guidanceRow) {
    const guidanceCells = textRowCells(sheetXml, guidanceRow, sst);
    for (const x of best) {
      const parsed = guidanceCells[x.col] ? parseGuidance(guidanceCells[x.col]) : null;
      if (!parsed) continue;
      const e = estimate(x);
      e.low = parsed.low;
      e.high = parsed.high;
    }
  } else {
    console.warn('Warning: "Total GMV Guidance" row not found — guidance columns left empty.');
  }
  const estRows = [...estimates.values()].sort((a, b) => a.quarter_end.localeCompare(b.quarter_end));
  const estCsv =
    "quarter,quarter_end,guidance_low_usd,guidance_high_usd,clearline_estimate_usd\n" +
    estRows.map((r) => `${r.quarter},${r.quarter_end},${r.low},${r.high},${r.cl}`).join("\n") +
    "\n";
  writeFileSync(OUT_ESTIMATES_CSV, estCsv);

  // --- report + validation anchors ---
  const first = series[0], last = series[series.length - 1];
  console.log(`Wrote ${series.length} quarters -> ${path.relative(process.cwd(), OUT_CSV)}`);
  console.log(`Range: ${first.quarter} (${first.quarter_end}) -> ${last.quarter} (${last.quarter_end})`);
  const fy25 = series
    .filter((r) => ["2024Q4", "2025Q1", "2025Q2", "2025Q3"].includes(r.quarter))
    .reduce((s, r) => s + r.reported_gmv_usd, 0);
  console.log(`FY2025 (Dec24+Mar25+Jun25+Sep25) = $${(fy25 / 1e6).toFixed(1)}M  [model anchor: $1,570.9M]`);
  console.log("Sample:", series.slice(0, 2).concat(series.slice(-2)).map((r) => `${r.quarter}=$${(r.reported_gmv_usd / 1e6).toFixed(1)}M`).join(", "));
  console.log(`Wrote ${estRows.length} estimate rows -> ${path.relative(process.cwd(), OUT_ESTIMATES_CSV)}`);
  for (const r of estRows.slice(0, 4)) {
    const g = r.low !== "" ? `guidance $${(r.low / 1e6).toFixed(0)}M-$${(r.high / 1e6).toFixed(0)}M` : "no guidance";
    const c = r.cl !== "" ? `Clearline $${(r.cl / 1e6).toFixed(1)}M` : "no Clearline est.";
    console.log(`  ${r.quarter} (${r.quarter_end}): ${g}, ${c}`);
  }
}

main();
