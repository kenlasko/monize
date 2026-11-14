import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import {
  createMoveFixture,
  exists,
  movedSnapshot,
  MoveFixture,
  snapshot,
} from "../test-support/move-fixture";
import { readLocationSync } from "./location";
import { MoveOutcome, runMove } from "./move";
import { nodeMoveFs } from "./move-fs";
import { MoveFs } from "./move-types";
import { stagingFor } from "./target";
import { withFault } from "./test-faults";

const BACKUP = "backups/user-1/monize-backup-daily-2026-11-12.json.gz";

describe("runMove", () => {
  let fixture: MoveFixture;
  let before: Record<string, string>;
  beforeEach(() => {
    fixture = createMoveFixture();
    before = snapshot(fixture.source);
  });
  afterEach(() => fixture.cleanup());

  const request = () => ({
    id: "move-1",
    source: fixture.source,
    target: fixture.target,
    now: new Date("2026-11-13T10:00:00.000Z"),
  });
  const run = (fs: MoveFs = nodeMoveFs, overrides = {}) =>
    runMove(fixture.deps(fs, overrides), request());

  /** What every failure before the commit must leave behind. */
  function expectOldFolderAuthoritative(outcome: MoveOutcome): void {
    expect(outcome).toMatchObject({ kind: "failed", leftover: [] });
    expect(snapshot(fixture.source)).toEqual(before);
    expect(readLocationSync(fixture.locationFile, "linux")).toBeNull();
    expect(exists(fixture.target)).toBe(false);
    expect(exists(stagingFor(fixture.target))).toBe(false);
    expect(exists(fixture.journalFile)).toBe(false);
  }

  it("copies, verifies, renames into place, then switches the pointer", async () => {
    utimesSync(
      join(fixture.source, BACKUP),
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-01T00:00:00Z"),
    );
    before = snapshot(fixture.source);
    const outcome = await run();

    expect(outcome).toEqual({ kind: "moved", warnings: [] });
    expect(readLocationSync(fixture.locationFile, "linux")).toEqual({
      dataDir: fixture.target,
      previousDataDir: fixture.source,
      state: "pending",
      movedAt: "2026-11-13T10:00:00.000Z",
    });
    // The copy holds the data; of the Chromium profile only its key file.
    expect(snapshot(fixture.target)).toEqual(movedSnapshot(fixture.source));
    expect(snapshot(fixture.target)).toHaveProperty("pgdata/pg_notify/");
    expect(snapshot(fixture.target)).not.toHaveProperty("shell/Network/");
    // A backup keeps the date it was written, which the application shows.
    expect(statSync(join(fixture.target, BACKUP)).mtimeMs).toBe(
      statSync(join(fixture.source, BACKUP)).mtimeMs,
    );
    // PostgreSQL refuses a cluster directory that others can read.
    expect(statSync(join(fixture.target, "pgdata")).mode & 0o777).toBe(0o700);
    // The old folder is whole, plus the note that says where its data went.
    const { "moved-elsewhere.json": tombstone, ...rest } = snapshot(
      fixture.source,
    );
    expect(rest).toEqual(before);
    expect(JSON.parse(tombstone)).toMatchObject({ movedTo: fixture.target });
    expect(exists(fixture.journalFile)).toBe(false);
    expect(exists(stagingFor(fixture.target))).toBe(false);
    expect(fixture.progress.map((item) => item.phase)).toEqual(
      expect.arrayContaining([
        "preparing",
        "copying",
        "verifying",
        "switching",
      ]),
    );
  });

  it("takes the place of an existing empty target folder", async () => {
    mkdirSync(fixture.target);
    expect((await run()).kind).toBe("moved");
    expect(snapshot(fixture.target)).toEqual(movedSnapshot(fixture.source));
  });

  it("copy fails midway: the partial copy is removed and nothing changed", async () => {
    const copyFile = jest
      .fn<ReturnType<MoveFs["copyFile"]>, Parameters<MoveFs["copyFile"]>>()
      .mockImplementationOnce(nodeMoveFs.copyFile)
      .mockImplementationOnce(nodeMoveFs.copyFile)
      .mockRejectedValue(new Error("ENOSPC: no space left on device"));
    const outcome = await run({ ...nodeMoveFs, copyFile });

    expect(outcome).toMatchObject({ failure: "copy-failed" });
    expect((outcome as { message: string }).message).toContain("ENOSPC");
    expectOldFolderAuthoritative(outcome);
  });

  it("the injected copy fault fails the same way", async () => {
    for (let index = 0; index < 30; index += 1) {
      writeFileSync(join(fixture.source, "backups", `f${index}`), "x");
    }
    before = snapshot(fixture.source);
    expectOldFolderAuthoritative(await run(withFault(nodeMoveFs, "copy")));
  });

  it("verify mismatch: a file that reads back differently stops the move", async () => {
    const outcome = await run(withFault(nodeMoveFs, "verify"));
    expect(outcome).toMatchObject({ failure: "verify-mismatch" });
    expectOldFolderAuthoritative(outcome);
  });

  it("verify mismatch: a file missing from the copy stops the move", async () => {
    const outcome = await run({
      ...nodeMoveFs,
      async copyFile(from, to, mode) {
        const digest = await nodeMoveFs.copyFile(from, to, mode);
        if (to.endsWith("pg_control")) await nodeMoveFs.removeFile(to);
        return digest;
      },
    });
    expect(outcome).toMatchObject({ failure: "verify-mismatch" });
    expectOldFolderAuthoritative(outcome);
  });

  it("the original changing during the copy stops the move", async () => {
    const changed = join(fixture.source, "pgdata", "PG_VERSION");
    const outcome = await run({
      ...nodeMoveFs,
      async digest(path) {
        utimesSync(changed, new Date(), new Date("2030-01-01T00:00:00Z"));
        return nodeMoveFs.digest(path);
      },
    });
    expect(outcome).toMatchObject({ failure: "source-changed" });
    expect(exists(fixture.target)).toBe(false);
    expect(exists(stagingFor(fixture.target))).toBe(false);
    expect(readLocationSync(fixture.locationFile, "linux")).toBeNull();
  });

  it("Chromium rewriting its key file during the copy does not", async () => {
    const key = join(fixture.source, "shell", "Local State");
    const outcome = await run({
      ...nodeMoveFs,
      async digest(path) {
        utimesSync(key, new Date(), new Date("2030-01-01T00:00:00Z"));
        return nodeMoveFs.digest(path);
      },
    });
    expect(outcome.kind).toBe("moved");
  });

  it("a log line written during the copy does not either, and the copy holds the log as it was read", async () => {
    const log = join(fixture.source, "logs", "main.log");
    const outcome = await run({
      ...nodeMoveFs,
      async copyFile(from, to, mode) {
        const digest = await nodeMoveFs.copyFile(from, to, mode);
        appendFileSync(log, "a late line\n");
        return digest;
      },
    });
    expect(outcome.kind).toBe("moved");
    expect(snapshot(fixture.target)["logs/main.log"]).toMatch(/^a line\n/);
  });

  it("a log rotated away before it could be copied is left out", async () => {
    const rotated = join(fixture.source, "logs", "main.log.4");
    writeFileSync(rotated, "oldest");
    const outcome = await run({
      ...nodeMoveFs,
      async copyFile(from, to, mode) {
        if (from === rotated) rmSync(rotated);
        return nodeMoveFs.copyFile(from, to, mode);
      },
    });
    expect(outcome.kind).toBe("moved");
    const copied = Object.keys(snapshot(fixture.target));
    expect(copied).not.toContain("logs/main.log.4");
    expect(copied).toContain("logs/main.log");
  });

  it("a data file that vanishes during the copy stops the move", async () => {
    const gone = join(fixture.source, "pgdata", "base", "1", "2619");
    const outcome = await run({
      ...nodeMoveFs,
      async copyFile(from, to, mode) {
        if (from === gone) rmSync(gone);
        return nodeMoveFs.copyFile(from, to, mode);
      },
    });
    expect(outcome).toMatchObject({ failure: "copy-failed", leftover: [] });
    expect(exists(stagingFor(fixture.target))).toBe(false);
  });

  it("target becomes non-empty: nothing is put there and it is not touched", async () => {
    mkdirSync(fixture.target);
    const theirs = join(fixture.target, "theirs.txt");
    const outcome = await run({
      ...nodeMoveFs,
      async syncDir(path) {
        if (path === stagingFor(fixture.target)) writeFileSync(theirs, "mine");
      },
    });

    expect(outcome).toMatchObject({
      failure: "target-not-empty",
      leftover: [],
    });
    expect(snapshot(fixture.target)).toEqual({ "theirs.txt": "mine" });
    expect(snapshot(fixture.source)).toEqual(before);
    expect(exists(stagingFor(fixture.target))).toBe(false);
    expect(readLocationSync(fixture.locationFile, "linux")).toBeNull();
  });

  it("the rename failing leaves the old folder in charge", async () => {
    const outcome = await run({
      ...nodeMoveFs,
      rename: async () => {
        throw new Error("EPERM");
      },
    });
    expect(outcome).toMatchObject({ failure: "place-failed" });
    expectOldFolderAuthoritative(outcome);
  });

  it("pointer write fails: the finished copy is removed, the old folder stays in charge", async () => {
    const outcome = await run(withFault(nodeMoveFs, "pointer"));
    expect(outcome).toMatchObject({ failure: "pointer-failed" });
    expectOldFolderAuthoritative(outcome);
  });

  it("pointer write reports failure but took effect: the move stands", async () => {
    const outcome = await run({
      ...nodeMoveFs,
      async writeFileAtomic(path, data) {
        await nodeMoveFs.writeFileAtomic(path, data);
        if (path === fixture.locationFile) throw new Error("EIO after rename");
      },
    });
    expect(outcome.kind).toBe("moved");
    expect(snapshot(fixture.target)).toEqual(movedSnapshot(fixture.source));
  });

  it("pointer write fails and cannot be read back: nothing is deleted", async () => {
    const outcome = await run(withFault(nodeMoveFs, "pointer"), {
      readLocation: () => {
        throw new Error("EIO");
      },
    });
    expect(outcome.kind).toBe("uncertain");
    expect(snapshot(fixture.source)).toEqual(before);
    // The copy and the journal stay for the next launch to settle.
    expect(exists(join(fixture.target, "config.json"))).toBe(true);
    expect(exists(fixture.journalFile)).toBe(true);
  });

  it("a cancel between two files removes the partial copy", async () => {
    const signal = { cancelled: false };
    const outcome = await run(
      {
        ...nodeMoveFs,
        async copyFile(from, to, mode) {
          signal.cancelled = true;
          return nodeMoveFs.copyFile(from, to, mode);
        },
      },
      { signal },
    );
    expect(outcome).toMatchObject({ failure: "cancelled" });
    expectOldFolderAuthoritative(outcome);
  });

  it("refuses to copy a database a server still has open", async () => {
    writeFileSync(join(fixture.source, "pgdata", "postmaster.pid"), "123\n");
    const outcome = await run();
    expect(outcome).toMatchObject({ failure: "source-busy", leftover: [] });
    expect(exists(stagingFor(fixture.target))).toBe(false);
    expect(exists(fixture.journalFile)).toBe(false);
  });

  it("refuses a link among the data rather than copy around it", async () => {
    symlinkSync("/etc", join(fixture.source, "pgdata", "pg_tblspc", "16400"));
    before = snapshot(fixture.source);
    const outcome = await run();
    expect(outcome).toMatchObject({ failure: "unsupported-entry" });
    expectOldFolderAuthoritative(outcome);
  });

  it("does not remove a staging folder that is somebody else's", async () => {
    const staging = stagingFor(fixture.target);
    mkdirSync(staging);
    writeFileSync(join(staging, "theirs.txt"), "mine");
    const outcome = await run();
    expect(outcome).toMatchObject({ failure: "copy-failed", leftover: [] });
    expect(snapshot(staging)).toEqual({ "theirs.txt": "mine" });
  });

  it("failing to mark the old folder is a warning, not a failed move", async () => {
    chmodSync(fixture.source, 0o500);
    try {
      const outcome = await run();
      expect(outcome).toMatchObject({
        kind: "moved",
        warnings: [expect.stringContaining("marking the old folder")],
      });
      // The journal stays, so the next launch writes the note.
      expect(exists(fixture.journalFile)).toBe(true);
    } finally {
      chmodSync(fixture.source, 0o700);
    }
  });
});
