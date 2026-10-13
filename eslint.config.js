// Lint for the vendor console (src/) and the control API (api/src, api/scripts). Run by
// `pnpm lint` and the CI workflow (.github/workflows/ci.yml).
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // .claude/: local agent worktrees of this repository (not part of it).
  { ignores: ["dist/**", "api/dist/**", "node_modules/**", "api/node_modules/**", "coverage/**", ".claude/**", "e2e-report/**", "e2e-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
  {
    files: ["api/**/*.{ts,mjs}", "packages/*/scripts/**/*.mjs", "e2e/**/*.{ts,mjs}", "*.config.{js,ts}"],
    languageOptions: { globals: globals.node },
  },
);
