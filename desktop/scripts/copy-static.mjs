#!/usr/bin/env node
// Copies the shell's static files (the splash and log viewer pages and their stylesheets) next to
// the compiled main process, which loads them from dist/ by its own __dirname. The splash's logo
// is the frontend's own file, copied rather than kept twice.
// tsc copies nothing that is not TypeScript; a bundler replaces this later.

import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const STATIC_FILES = [
  "splash/splash.html",
  "splash/splash.css",
  "log-viewer/log-viewer.html",
  "log-viewer/log-viewer.css",
];

/** Files from elsewhere in the repository: dist/ path -> path from the repository root. */
export const SHARED_FILES = {
  "splash/monize-logo.svg": "frontend/public/icons/monize-logo-transparent.svg",
};

function copy(from, file) {
  const to = path.join(desktopRoot, "dist", file);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}

for (const file of STATIC_FILES) {
  copy(path.join(desktopRoot, "src", file), file);
}
for (const [file, from] of Object.entries(SHARED_FILES)) {
  copy(path.join(desktopRoot, "..", from), file);
}
