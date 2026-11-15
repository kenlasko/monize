/* global module */
/** @type {import('jest').Config} */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/**/*.spec.ts"],
  transform: { "^.+\\.ts$": "ts-jest" },
  // Packaging output: tens of thousands of files, among them the layers' own
  // package.json, which jest would otherwise index and report as collisions.
  modulePathIgnorePatterns: [
    "<rootDir>/staging/",
    "<rootDir>/release/",
    "<rootDir>/dist/",
  ],
};
