import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/worker.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  conditions: ["workerd", "worker", "browser"],
  external: ["cloudflare:*", "node:*"],
  plugins: [{
    name: "node-path",
    setup(builder) {
      // mime-types uses require("path"); bridge it to Workers' native ESM module.
      builder.onResolve({ filter: /^path$/ }, () => ({ path: "path", namespace: "node-path" }));
      builder.onLoad({ filter: /.*/, namespace: "node-path" }, () => ({
        contents: 'export * from "node:path"; import path from "node:path"; export default path;',
      }));
    },
  }],
});
