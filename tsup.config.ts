import { defineConfig } from "tsup";

// Two entry points (./ for boundedWatch, ./server for makeServer);
// each builds ESM + CJS + .d.ts. tsup rewrites the .ts extensions in
// relative imports automatically — that's why this works alongside
// `allowImportingTsExtensions: true` in tsconfig.json.
export default defineConfig({
  entry: {
    "client/index": "src/client/index.ts",
    "server/index": "src/server/index.ts",
  },
  outDir: "dist",
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: false,
  target: "node20",
  // Don't bundle deps — let consumers resolve their own versions.
  external: ["@modelcontextprotocol/sdk", "@supabase/supabase-js", "postgres", "zod"],
});
