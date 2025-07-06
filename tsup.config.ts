import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/migrations.ts"],
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "node18",
  outDir: "dist",
  external: ["debug", "pluralize", "pg"],
  treeshake: true,
  minify: false,
});
