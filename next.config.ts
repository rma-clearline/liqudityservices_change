import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server bundle (.next/standalone/server.js) for the Docker image
  // used by Azure Container Apps.
  output: "standalone",
  outputFileTracingIncludes: {
    "/api/forecast": [
      "./scripts/historical-gmv-daily-*.csv",
      "./scripts/historical-gmv-daily-market-*.csv",
    ],
    // The GMV export reads the same historical daily CSV so its historical months
    // reconcile to the forecast's monthly table exactly (loadHistoricalDailyTotalsForExport).
    "/api/export/gmv": [
      "./scripts/historical-gmv-daily-*.csv",
      "./scripts/historical-gmv-daily-market-*.csv",
    ],
  },
};

export default nextConfig;
