/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      // Serve the Farcaster Mini App manifest at the well-known path.
      { source: "/.well-known/farcaster.json", destination: "/api/farcaster-manifest" },
      // Machine-readable x402 service catalog for agent/indexer discovery.
      { source: "/.well-known/x402", destination: "/api/catalog" },
      // AI/agent discovery files.
      { source: "/llms.txt", destination: "/api/llms" },
      { source: "/openapi.json", destination: "/api/openapi" },
    ];
  },
  async headers() {
    // Public, read-only discovery endpoints are meant to be fetched by agents
    // and browsers from anywhere — allow CORS explicitly. Gated/spend endpoints
    // (revenue, usage, payments, buy, cron) are deliberately NOT listed.
    return [
      {
        source: "/api/:path(catalog|openapi|llms|status|public-stats)",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
      {
        source: "/api/x402/:service*",
        headers: [{ key: "Access-Control-Allow-Origin", value: "*" }],
      },
    ];
  },
};

export default nextConfig;
