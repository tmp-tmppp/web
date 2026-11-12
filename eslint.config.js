import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["dist/", "coverage/", "reports/", "node_modules/", "helm/"] },
  {
    files: ["**/*.{ts,tsx}"],
    extends: [js.configs.recommended, tseslint.configs.recommendedTypeChecked, reactHooks.configs.flat.recommended],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
      // Tokens must never reach localStorage (ADR-024): the OIDC library is configured with sessionStorage.
      "no-restricted-globals": ["error", { name: "localStorage", message: "Tokens and sessions live in sessionStorage or memory only." }],
      "no-restricted-properties": ["error", { object: "window", property: "localStorage", message: "Tokens and sessions live in sessionStorage or memory only." }],
    },
  },
  {
    files: ["**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ["tests/**/*.{ts,tsx}"],
    rules: {
      // Parsed JSON bodies and library mocks in tests are untyped on purpose.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      // The localStorage rule is checked by a test that reads the storage, which needs the name.
      "no-restricted-globals": "off",
      "no-restricted-properties": "off",
    },
  },
);
