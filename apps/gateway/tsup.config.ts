import { defineConfig } from "tsup";

// Single self-contained bundle: the runtime image needs no node_modules (fast cold start, D13a).
export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  noExternal: [/.*/],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  clean: true,
});
