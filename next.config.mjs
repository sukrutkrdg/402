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
};

export default nextConfig;
