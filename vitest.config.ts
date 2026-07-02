import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // `@/` path alias mirrors tsconfig.
      "@": path.resolve(__dirname, "src"),
      // Neutralise the Next.js RSC-only guard so lib modules import in tests.
      "server-only": path.resolve(__dirname, "test/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    globals: true,
  },
});
