import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginPrettier from "eslint-plugin-prettier/recommended";

export default tseslint.config(
  { ignores: ["dist/**", "staging/**", "release/**", "node_modules/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  eslintPluginPrettier,
  {
    languageOptions: { sourceType: "module" },
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Preloads a child loads with `--require`: CommonJS, run by Node itself.
    files: ["resources/**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { require: "readonly", process: "readonly" },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
