import { defineConfig } from "tsup";

export default defineConfig({
  entry: { empo: "src/empo.ts" },
  format: ["esm"],
  target: "node22",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
