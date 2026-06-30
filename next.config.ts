import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  outputFileTracingIncludes: {
    "/api/forecast": [
      "./scripts/historical-gmv-daily-*.csv",
      "./scripts/historical-gmv-daily-market-*.csv",
    ],
  },
};

export default nextConfig;
