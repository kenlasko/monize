#!/usr/bin/env node
// Copies the shell's static files (the splash page and its stylesheet) next to
// the compiled main process, which loads them from dist/ by its own __dirname.
// tsc copies nothing that is not TypeScript; a bundler replaces this later.

import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const STATIC_FILES = ["splash/splash.html", "splash/splash.css"];

for (const file of STATIC_FILES) {
  const to = path.join(desktopRoot, "dist", file);
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(path.join(desktopRoot, "src", file), to);
}
