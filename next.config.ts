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
  },
};

export default nextConfig;
