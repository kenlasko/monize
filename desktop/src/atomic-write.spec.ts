import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { writeFileAtomic } from "./atomic-write";

describe("writeFileAtomic", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monize-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file and leaves no temporary behind", async () => {
    const target = join(dir, "config.json");
    await writeFileAtomic(target, Buffer.from("one"));
    await writeFileAtomic(target, Buffer.from("two"));
    expect(readFileSync(target, "utf8")).toBe("two");
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  it("creates the file owner-only on POSIX", async () => {
    if (process.platform === "win32") return;
    const target = join(dir, "config.json");
    await writeFileAtomic(target, Buffer.from("x"));
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("rejects when the directory is missing and leaves nothing behind", async () => {
    const target = join(dir, "missing-dir", "config.json");
    await expect(writeFileAtomic(target, Buffer.from("x"))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("keeps the previous file and cleans up when the rename fails", async () => {
    // A directory at the final name makes rename(2) fail after the temporary
    // file has been fully written.
    const target = join(dir, "config.json");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "old");
    await expect(writeFileAtomic(target, Buffer.from("x"))).rejects.toThrow();
    expect(readdirSync(dir)).toEqual(["config.json"]);
    expect(readFileSync(join(target, "keep"), "utf8")).toBe("old");
  });
});
