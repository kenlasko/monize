#!/usr/bin/env node
// Regenerates build/icon.ico from the project's artwork. Run by hand when the
// logo changes, from a checkout whose frontend/ is installed:
//
//   node scripts/make-icon.mjs
//
// It borrows `sharp` from frontend/node_modules for the resizing (the desktop
// package does not depend on it) and writes the ICO container itself. The
// source is frontend/public/icons/icon-512x512.png: a square canvas with the
// round mark on a transparent background, the same image the web manifest
// uses. The 256 pixel entry is stored as PNG, which every Windows since Vista
// reads; the smaller ones are stored as 32-bit bitmaps, the form every
// consumer of an .ico accepts (the NSIS compiler and the resource editor
// included).

import { Buffer } from "node:buffer";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_FROM = 256;

const desktopRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = path.resolve(desktopRoot, "..");
const SOURCE = path.join(repoRoot, "frontend/public/icons/icon-512x512.png");
const TARGET = path.join(desktopRoot, "build", "icon.ico");

/** A 32-bit device-independent bitmap as an .ico stores it: XOR rows, then the AND mask. */
export function bitmapEntry(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // the image and its mask, stacked
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    const from = (size - 1 - y) * size * 4; // rows are stored bottom-up
    for (let x = 0; x < size; x += 1) {
      const s = from + x * 4;
      const d = (y * size + x) * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }
  // The alpha channel carries the transparency; the 1-bit mask stays zero.
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

/** The .ico container: a directory of entries, then each image. */
export function icoFile(entries) {
  const dir = Buffer.alloc(6 + entries.length * 16);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let offset = dir.length;
  entries.forEach(({ size, data }, index) => {
    const at = 6 + index * 16;
    dir.writeUInt8(size === 256 ? 0 : size, at);
    dir.writeUInt8(size === 256 ? 0 : size, at + 1);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([dir, ...entries.map((entry) => entry.data)]);
}

async function main() {
  const require = createRequire(path.join(repoRoot, "frontend", "noop.js"));
  const sharp = require("sharp");
  const entries = [];
  for (const size of ICON_SIZES) {
    const resized = sharp(SOURCE).resize(size, size, { kernel: "lanczos3" });
    const data =
      size >= PNG_FROM
        ? await resized.png({ compressionLevel: 9 }).toBuffer()
        : bitmapEntry(await resized.ensureAlpha().raw().toBuffer(), size);
    entries.push({ size, data });
  }
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  fs.writeFileSync(TARGET, icoFile(entries));
  process.stdout.write(
    `${path.relative(repoRoot, TARGET)}: ${ICON_SIZES.join(", ")} px\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`make-icon: ${error.message}\n`);
    process.exitCode = 1;
  });
}
