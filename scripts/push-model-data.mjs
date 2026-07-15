// Push the model-derived CSVs (reported GMV, guidance, Clearline estimates, model
// metrics) to the production Container App as SECRETS — the CSVs are gitignored and
// never committed, so this is how prod gets them. Values are base64(gzip(csv)):
// base64 survives CLI quoting, and gzip keeps the az command line far below
// cmd.exe's 32K limit (az is a batch file, so the whole command runs through
// cmd.exe — the raw metrics CSV alone exceeded the limit). The app's loaders
// decode transparently (and still accept plain base64 or plain CSV).
//
// Quarterly refresh, one command each:
//   node scripts/extract-reported-gmv.mjs     # model workbook -> local CSVs
//   node scripts/push-model-data.mjs          # local CSVs -> ACA secrets + restart
//
// Requires: az CLI logged in with access to the Container App. One-time setup on the
// app (already done): a secret volume mounted at /mnt/model-data and the env vars
// REPORTED_GMV_QUARTERLY_PATH / MODEL_ESTIMATES_QUARTERLY_PATH /
// MODEL_METRICS_QUARTERLY_PATH pointing at the mounted secret files.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP = process.env.LQDT_APP_NAME || "lqdt-web";
const RG = process.env.LQDT_RESOURCE_GROUP || "cl-tool-rg";

const FILES = [
  { csv: "reported-gmv-quarterly.csv", secret: "reported-gmv-quarterly-csv" },
  { csv: "model-estimates-quarterly.csv", secret: "model-estimates-quarterly-csv" },
  { csv: "model-metrics-quarterly.csv", secret: "model-metrics-quarterly-csv" },
];

function az(args) {
  // az is az.cmd (a batch file) on Windows, so this must run through the shell —
  // and cmd.exe treats "=" as an argument delimiter, so any arg containing "=" must
  // be double-quoted or the name=value pairs get split before az ever sees them.
  const quoted = args.map((a) => (a.includes("=") ? `"${a}"` : a));
  return execFileSync("az", quoted, { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

const pairs = [];
for (const f of FILES) {
  const p = path.join(SCRIPTS_DIR, f.csv);
  const text = readFileSync(p, "utf8"); // throws if missing — run the extractor first
  const lines = text.trim().split(/\r?\n/).length - 1;
  const encoded = gzipSync(Buffer.from(text, "utf8")).toString("base64");
  pairs.push(`${f.secret}=${encoded}`);
  console.log(`${f.csv}: ${lines} rows -> secret ${f.secret} (${encoded.length} b64 chars)`);
}

console.log(`Setting secrets on ${APP} (${RG})...`);
az(["containerapp", "secret", "set", "-n", APP, "-g", RG, "--secrets", ...pairs]);

// Secret-volume file contents only refresh on a new revision; restart the latest.
console.log("Restarting latest revision to pick up the new files...");
const revision = az(["containerapp", "revision", "list", "-n", APP, "-g", RG, "--query", "[?properties.active].name | [0]", "-o", "tsv"]).trim();
az(["containerapp", "revision", "restart", "-n", APP, "-g", RG, "--revision", revision]);
console.log(`Done. Restarted ${revision}.`);
