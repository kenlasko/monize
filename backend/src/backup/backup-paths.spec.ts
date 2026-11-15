import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "fs";
import { tmpdir } from "os";
import { join, posix, win32 } from "path";

import {
  assertWithinAllowedRoots,
  BackupPathNotAllowedError,
  resolveAllowedRoots,
} from "./backup-paths";

/**
 * `BACKUP_ALLOWED_ROOTS` parsing and the containment check under both
 * platforms' path semantics. The win32 cases run the same production functions
 * through `path.win32` (the pattern `common/jest-config.guard.spec.ts` follows)
 * instead of mocking `process.platform`. None of the win32 paths exists on a
 * Linux runner, so their containment is decided lexically -- which is exactly
 * the walk-up-to-the-drive-root branch a fresh Windows install takes.
 */
describe("resolveAllowedRoots", () => {
  it("splits a POSIX list on ':' and keeps only absolute entries", () => {
    expect(
      resolveAllowedRoots(
        "/mnt/nas/monize: relative/dir :/data/backups/",
        "/data/backups",
        posix,
      ),
    ).toEqual(["/data/backups", "/mnt/nas/monize"]);
  });

  it("defaults to the backup folder alone", () => {
    expect(resolveAllowedRoots(undefined, "/data/backups", posix)).toEqual([
      "/data/backups",
    ]);
  });

  it("splits a Windows list on ';' and keeps the drive letter intact", () => {
    expect(
      resolveAllowedRoots(
        "D:\\nas\\monize;relative\\dir;C:drive-relative;\\\\server\\share\\monize",
        "C:\\Monize\\backups",
        win32,
      ),
    ).toEqual([
      "C:\\Monize\\backups",
      "D:\\nas\\monize",
      "\\\\server\\share\\monize",
    ]);
  });
});

describe("assertWithinAllowedRoots", () => {
  describe("under win32 semantics", () => {
    const roots = ["C:\\Monize\\backups"];

    it("accepts the root and a not-yet-created folder beneath it", async () => {
      await expect(
        assertWithinAllowedRoots("C:\\Monize\\backups", roots, win32),
      ).resolves.toBe("C:\\Monize\\backups");
      await expect(
        assertWithinAllowedRoots(
          "C:\\Monize\\backups\\22\\22\\user",
          roots,
          win32,
        ),
      ).resolves.toBe("C:\\Monize\\backups\\22\\22\\user");
    });

    it("refuses a drive change, traversal, a UNC path and a prefix sibling", async () => {
      for (const bad of [
        "D:\\x",
        "C:\\Monize\\backups\\..\\..\\Windows",
        "\\\\server\\share\\x",
        "C:\\Monize\\backups-evil",
      ]) {
        await expect(
          assertWithinAllowedRoots(bad, roots, win32),
        ).rejects.toBeInstanceOf(BackupPathNotAllowedError);
      }
    });
  });

  describe("on the host filesystem", () => {
    let root: string;

    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "monize-backup-paths-"));
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it("accepts a missing folder under an existing root", async () => {
      const allowed = join(root, "allowed");
      mkdirSync(allowed);

      await expect(
        assertWithinAllowedRoots(join(allowed, "a", "b"), [allowed]),
      ).resolves.toBe(join(allowed, "a", "b"));
    });

    it("refuses a symlink inside a root that leads out of it", async () => {
      const allowed = join(root, "allowed");
      const outside = join(root, "outside");
      mkdirSync(allowed);
      mkdirSync(outside);
      symlinkSync(outside, join(allowed, "escape"));

      await expect(
        assertWithinAllowedRoots(join(allowed, "escape", "x"), [allowed]),
      ).rejects.toBeInstanceOf(BackupPathNotAllowedError);
    });
  });
});
