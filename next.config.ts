import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vinext checks multipart requests against the action limit before API dispatch.
  // Leave room for form metadata while createMessage enforces 10 MB per file.
  experimental: { serverActions: { bodySizeLimit: "12mb" } },
};

export default nextConfig;
