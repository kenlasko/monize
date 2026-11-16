// Self-test for the signed-installer step: scripts/lib/update-info.mjs and
// peHasSignature in scripts/lib/pe.mjs. Run: node --test scripts/update-info.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileHasSignature, peHasSignature } from "./lib/pe.mjs";
import { buildBlockMap, rewriteUpdateInfo } from "./lib/update-info.mjs";

const FILE = "Monize-Setup-1.21.1-beta.4761.exe";
const OLD =
  "7oKelpCaR5b+F1rpiWczDD3ZoTiCRo6IzNhp+sQWsgcKIBkPwhSg/HMl4iXZAuQt69bLGQAY83/atzWyr5Rl+g==";
const NEW = crypto.createHash("sha512").update("signed").digest("base64");

// electron-builder's output for the v1.21.1-beta.4761 prerelease, verbatim.
const FEED = `version: 1.21.1-beta.4761
files:
  - url: ${FILE}
    sha512: ${OLD}
    size: 255982667
path: ${FILE}
sha512: ${OLD}
releaseDate: '2026-11-16T12:25:03.924Z'
`;

test("rewriteUpdateInfo changes only the two sha512 values and the size", () => {
  const result = rewriteUpdateInfo(FEED, {
    file: FILE,
    sha512: NEW,
    size: 255991000,
  });
  assert.equal(
    result,
    FEED.replaceAll(OLD, NEW).replace("size: 255982667", "size: 255991000"),
  );
});

test("rewriteUpdateInfo refuses an installer that did not change", () => {
  assert.throws(
    () => rewriteUpdateInfo(FEED, { file: FILE, sha512: OLD, size: 255982667 }),
    /was not changed \(signed\)/,
  );
});

test("rewriteUpdateInfo refuses a feed for another file or of another shape", () => {
  const args = { file: FILE, sha512: NEW, size: 1 };
  assert.throws(
    () => rewriteUpdateInfo(FEED, { ...args, file: "Monize-Setup-1.0.0.exe" }),
    /one files entry/,
  );
  assert.throws(
    () =>
      rewriteUpdateInfo(FEED.replace(`path: ${FILE}`, "path: other.exe"), args),
    /expected "path:/,
  );
  const two = FEED.replace(
    "path:",
    `  - url: other.exe\n    sha512: ${OLD}\n    size: 2\npath:`,
  );
  assert.throws(() => rewriteUpdateInfo(two, args), /one files entry/);
  const split = FEED.replace(`\nsha512: ${OLD}`, `\nsha512: ${NEW}`);
  assert.throws(() => rewriteUpdateInfo(split, args), /disagree/);
  assert.throws(
    () => rewriteUpdateInfo(FEED, { ...args, sha512: "abc" }),
    /base64 SHA-512/,
  );
  assert.throws(
    () => rewriteUpdateInfo(FEED, { ...args, size: 0 }),
    /file size/,
  );
});

/** A minimal PE32+ image whose security directory is `security`, if given. */
function fakePe(security) {
  const buffer = Buffer.alloc(0x400);
  buffer.write("MZ", 0, "latin1");
  buffer.writeUInt32LE(0x40, 0x3c);
  buffer.write("PE\0\0", 0x40, "latin1");
  buffer.writeUInt16LE(0x8664, 0x44);
  buffer.writeUInt16LE(240, 0x54); // size of the optional header
  const optional = 0x58;
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeUInt32LE(16, optional + 108); // data directories
  if (security) {
    buffer.writeUInt32LE(security.offset, optional + 112 + 4 * 8);
    buffer.writeUInt32LE(security.size, optional + 112 + 4 * 8 + 4);
  }
  return buffer;
}

test("peHasSignature finds a certificate table inside the file and nothing else", () => {
  assert.equal(peHasSignature(fakePe()), false);
  assert.equal(peHasSignature(fakePe({ offset: 0x300, size: 0x100 })), true);
  assert.equal(peHasSignature(fakePe({ offset: 0x300, size: 0x200 })), false);
  assert.equal(
    peHasSignature(fakePe({ offset: 0x300, size: 0x200 }), 0x500),
    true,
  );
  assert.throws(
    () => peHasSignature(Buffer.from("not an image")),
    /not a PE image/,
  );
});

test("fileHasSignature reads only the headers but checks against the file's size", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monize-sign-test-"));
  const file = path.join(dir, "big.exe");
  const image = Buffer.alloc(0x3000);
  fakePe({ offset: 0x2000, size: 0x1000 }).copy(image);
  fs.writeFileSync(file, image);
  assert.equal(fileHasSignature(file), true);
  fs.truncateSync(file, 0x2800);
  assert.equal(fileHasSignature(file), false);
});

test("electron-builder's blockmap function still resolves and hashes the whole file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "monize-blockmap-test-"));
  const file = path.join(dir, "installer.exe");
  const bytes = crypto.randomBytes(200_000);
  fs.writeFileSync(file, bytes);
  const info = await buildBlockMap(file, "gzip", `${file}.blockmap`);
  assert.equal(info.size, bytes.length);
  assert.equal(
    info.sha512,
    crypto.createHash("sha512").update(bytes).digest("base64"),
  );
  assert.ok(fs.statSync(`${file}.blockmap`).size > 0);
});
