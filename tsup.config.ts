import { defineConfig } from "tsup";

// Single-config build. RN apps consume the SDK via Metro (which
// resolves the "react-native" + "module" + "main" entries off
// package.json — see exports map). No UMD bundle (RN doesn't ship a
// CDN consumer path), no React-specific subpackage (apps using
// React Native already have React in the host context — the same
// `Crossdeck` singleton is consumed directly, no framework adapter
// needed at this layer).
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  outExtension({ format }) {
    if (format === "cjs") return { js: ".cjs" };
    if (format === "esm") return { js: ".mjs" };
    return { js: ".js" };
  },
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  splitting: false,
  // peerDeps are external — Metro / Hermes resolves them in the host
  // app. The optional `@react-native-async-storage/async-storage`
  // module is resolved lazily at runtime via the platform-storage
  // adapter, so bundling it would double the dependency tree.
  external: [
    "react",
    "react-native",
    "@react-native-async-storage/async-storage",
  ],
});
