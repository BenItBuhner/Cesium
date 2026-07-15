import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  // Patterns must be recursive (**/) so nested workspace build output
  // (apps/web/.next, apps/desktop/out, apps/*/dist, android intermediates)
  // is excluded; linting those took minutes and produced nothing.
  globalIgnores([
    "**/.next/**",
    "**/out/**",
    "**/build/**",
    "**/dist/**",
    ".docker/**",
    ".tmp/**",
    "**/next-env.d.ts",
    "**/public/**",
    "apps/mobile/android/**",
    "apps/desktop/.server-runtime/**",
  ]),
  {
    rules: {
      // Legitimate patterns (refs mirroring props, hydration from storage, reset-on-open) are flagged;
      // disabling keeps `npm run lint` usable without rewriting half the tree.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
    },
  },
  {
    // Node-side code: React hook naming/call rules don't apply outside React trees.
    files: ["server/**", "scripts/**", "apps/desktop/src/**", "apps/mobile/scripts/**"],
    rules: {
      "react-hooks/rules-of-hooks": "off",
      "react-hooks/exhaustive-deps": "off",
    },
  },
  {
    // CommonJS by definition; `require()` is the import mechanism.
    // metro-transformer.js is also a Metro worker entry that must use require()
    // to load non-exported internals via absolute paths.
    files: ["**/*.cjs", "**/metro.config.js", "**/metro-transformer.js"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
