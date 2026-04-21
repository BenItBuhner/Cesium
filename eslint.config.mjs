import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "server/dist/**",
    ".docker/**",
    "next-env.d.ts",
    "public/**",
  ]),
  {
    rules: {
      // Legitimate patterns (refs mirroring props, hydration from storage, reset-on-open) are flagged;
      // disabling keeps `npm run lint` usable without rewriting half the tree.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
    },
  },
]);

export default eslintConfig;
