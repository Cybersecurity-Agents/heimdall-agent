import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "console/src/**/*.test.tsx"],
    pool: "forks",
    server: { deps: { external: ["sqlite", "node:sqlite"] } },
  },
  ssr: { external: ["node:sqlite", "sqlite"] },
  resolve: {
    alias: [{ find: /^sqlite$/, replacement: "node:sqlite" }],
  },
});
