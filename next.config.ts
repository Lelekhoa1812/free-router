import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["mongodb"],
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
};

export default nextConfig;
