import nextConfig from "eslint-config-next";
import tseslint from "typescript-eslint";

export default [
  ...nextConfig,
  {
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_", ignoreRestSiblings: true }],
      "react/no-unescaped-entities": "off",
      // Downgrade React compiler rules to warnings until codebase is refactored
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/incompatible-library": "warn",
      "react-hooks/immutability": "warn",
    },
  },
];
