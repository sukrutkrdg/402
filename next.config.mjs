/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @x402/next runtime-imports "@x402/extensions/bazaar" with webpackIgnore, so
  // the package must exist as real files in the serverless bundle — otherwise
  // every request logs "Failed to load bazaar extension: Cannot find package".
  // Keeping it external makes Next trace it into node_modules instead of
  // bundling it away.
  serverExternalPackages: ["@x402/extensions"],
  async rewrites() {
    return [
      // Serve the Farcaster Mini App manifest at the well-known path.
      { source: "/.well-known/farcaster.json", destination: "/api/farcaster-manifest" },
      // Machine-readable x402 service catalog for agent/indexer discovery.
      { source: "/.well-known/x402", destination: "/api/catalog" },
      // Extra discovery filenames various scanners/directories crawl.
      { source: "/.well-known/x402.json", destination: "/api/catalog" },
      { source: "/.well-known/x402-bazaar.json", destination: "/api/catalog" },
      { source: "/.well-known/agent.json", destination: "/api/agent-card" },
      { source: "/.well-known/mcp.json", destination: "/api/mcp-manifest" },
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
        source: "/api/:path(catalog|openapi|llms|status|public-stats|agent-card|mcp-manifest)",
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
