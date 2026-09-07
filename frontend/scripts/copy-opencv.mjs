#!/usr/bin/env node
/**
 * Vendor OpenCV.js into `public/` so the document scanner can load it from our
 * own origin.
 *
 * It is not imported through the module graph -- see the reasoning in
 * `src/lib/document-scanner/opencv-engine.ts` -- so the bundler never sees it
 * and something has to put the file where the browser can fetch it. Copied
 * from `node_modules` at build time rather than committed, because it is a
 * 13 MB build artefact of a pinned dependency.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const source = join(
  root,
  "node_modules",
  "@techstark",
  "opencv-js",
  "dist",
  "opencv.js",
);
const targetDir = join(root, "public", "vendor", "opencv");
const target = join(targetDir, "opencv.js");

if (!existsSync(source)) {
  console.error(
    `[copy-opencv] ${source} is missing. Run npm install before building.`,
  );
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });

// Skip an identical copy so a rebuild does not rewrite 13 MB every time.
if (existsSync(target) && statSync(target).size === statSync(source).size) {
  console.log("[copy-opencv] public/vendor/opencv/opencv.js is up to date");
  process.exit(0);
}

copyFileSync(source, target);
console.log(
  `[copy-opencv] copied opencv.js (${(statSync(target).size / 1024 / 1024).toFixed(1)} MB) to public/vendor/opencv/`,
);
