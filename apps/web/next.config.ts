import type { NextConfig } from "next";
import { resolve } from "node:path";

const config: NextConfig = {
  transpilePackages: ["@livecanvas/dsl"],
  output: "standalone",
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  // packages/dsl uses NodeNext-style `./x.js` imports of `.ts` sources.
  webpack: (cfg) => {
    cfg.resolve.extensionAlias = { ".js": [".ts", ".tsx", ".js"] };
    return cfg;
  },
};
export default config;
