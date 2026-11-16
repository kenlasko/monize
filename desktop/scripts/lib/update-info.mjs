/**
 * Points the updater's feed file (latest.yml, or beta.yml for a beta) at an
 * installer that changed after electron-builder wrote the file. Signing does
 * that: it appends the signature to the .exe, so the sha512 and size that
 * electron-builder recorded no longer match, and electron-updater would
 * refuse the download.
 *
 * The file is electron-builder's own output for one NSIS installer:
 *
 *   version: 1.21.1-beta.4761
 *   files:
 *     - url: Monize-Setup-1.21.1-beta.4761.exe
 *       sha512: <base64>
 *       size: 255982667
 *   path: Monize-Setup-1.21.1-beta.4761.exe
 *   sha512: <base64>
 *   releaseDate: '2026-11-16T12:25:03.924Z'
 *
 * It is rewritten line by line rather than parsed and re-serialized, so that
 * nothing but the two values moves, and anything that does not look exactly
 * like this is refused instead of guessed at.
 */
import { createRequire } from "node:module";

const SHA512 = /^[A-Za-z0-9+/]{86}==$/;

export function rewriteUpdateInfo(text, { file, sha512, size }) {
  if (!SHA512.test(sha512)) {
    throw new Error(`not a base64 SHA-512: ${sha512}`);
  }
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`not a file size: ${size}`);
  }
  const lines = text.split("\n");
  const urls = lines.filter((line) => /^\s+- url: /.test(line));
  if (urls.length !== 1 || urls[0].trim() !== `- url: ${file}`) {
    throw new Error(
      `expected one files entry, for ${file}; found: ${urls.join(", ") || "none"}`,
    );
  }
  if (!lines.includes(`path: ${file}`)) {
    throw new Error(`expected "path: ${file}"`);
  }

  const shaLines = lines.filter((line) => /^\s*sha512: /.test(line));
  const sizeLines = lines.filter((line) => /^\s+size: /.test(line));
  if (shaLines.length !== 2 || sizeLines.length !== 1) {
    throw new Error(
      `expected two sha512 lines and one size line, found ${shaLines.length} and ${sizeLines.length}`,
    );
  }
  const old = new Set(shaLines.map((line) => line.split(": ")[1]));
  if (old.size !== 1) {
    throw new Error("the files entry and the top-level sha512 disagree");
  }
  if (old.has(sha512)) {
    throw new Error(
      `${file} still has the sha512 electron-builder recorded: it was not changed (signed) after the build`,
    );
  }

  return lines
    .map((line) => {
      if (/^\s*sha512: /.test(line)) {
        return line.replace(/sha512: .*$/, `sha512: ${sha512}`);
      }
      if (/^\s+size: /.test(line)) {
        return line.replace(/size: .*$/, `size: ${size}`);
      }
      return line;
    })
    .join("\n");
}

// The function, from the same exact-pinned electron-builder, that wrote the
// blockmap in the first place (NsisTarget, through createBlockmap): returns
// the file's { size, sha512 } and writes the blockmap to `outFile`. The
// package has no exports map, so the deep path resolves; an upgrade that
// moves it fails scripts/update-info.test.mjs.
const BLOCKMAP_MODULE = "app-builder-lib/out/targets/blockmap/blockmap.js";

export function buildBlockMap(file, compression, outFile) {
  const require = createRequire(import.meta.url);
  return require(BLOCKMAP_MODULE).buildBlockMap(file, compression, outFile);
}
