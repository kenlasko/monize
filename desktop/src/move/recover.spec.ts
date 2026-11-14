import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, posix } from "path";

import {
  createMoveFixture,
  exists,
  movedSnapshot,
  MoveFixture,
  snapshot,
} from "../test-support/move-fixture";
import { DataLocation, readLocationSync } from "./location";
import { runMove } from "./move";
import { nodeMoveFs } from "./move-fs";
import { MoveFs } from "./move-types";
import { recoverInterruptedMove } from "./recover";
import { stagingFor } from "./target";

/**
 * Each case kills the move at a point (by making the step after it throw
 * something `runMove` cannot handle, as a killed process would simply stop)
 * and then runs what the next launch runs.
 */
describe("recoverInterruptedMove", () => {
  let fixture: MoveFixture;
  let before: Record<string, string>;
  beforeEach(() => {
    fixture = createMoveFixture();
    before = snapshot(fixture.source);
  });
  afterEach(() => fixture.cleanup());

  class Killed extends Error {}

  /** Runs the move until `dies` returns true for a filesystem call. */
  async function moveUntil(
    dies: (operation: keyof MoveFs, path: string) => boolean,
  ): Promise<void> {
    let dead = false;
    const wrap = <K extends keyof MoveFs>(operation: K): MoveFs[K] =>
      ((...args: unknown[]) => {
        if (dead || dies(operation, String(args[0]))) {
          dead = true;
          // Never settles: a killed process runs no cleanup either.
          return new Promise(() => undefined);
        }
        return (nodeMoveFs[operation] as (...a: unknown[]) => unknown)(...args);
      }) as MoveFs[K];
    const fs = Object.fromEntries(
      (Object.keys(nodeMoveFs) as (keyof MoveFs)[]).map((key) => [
        key,
        wrap(key),
      ]),
    ) as unknown as MoveFs;
    void runMove(fixture.deps(fs), {
      id: "move-1",
      source: fixture.source,
      target: fixture.target,
      now: new Date("2026-11-13T10:00:00.000Z"),
    });
    for (let waited = 0; !dead && waited < 5000; waited += 10) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!dead) throw new Killed("the move never reached the kill point");
  }

  const recover = (location: DataLocation | null) =>
    recoverInterruptedMove({
      fs: nodeMoveFs,
      path: posix,
      journalFile: fixture.journalFile,
      location,
      log: (line) => fixture.logs.push(line),
    });
  const pointer = () =>
    readLocationSync(fixture.locationFile, process.platform);

  it("does nothing when no move was under way", async () => {
    expect(await recover(null)).toEqual({ kind: "none" });
  });

  it("killed while copying: the partial copy is removed, the old folder is the data folder", async () => {
    await moveUntil(
      (operation, path) => operation === "copyFile" && path.endsWith("2619"),
    );
    expect(exists(stagingFor(fixture.target))).toBe(true);

    expect(await recover(pointer())).toEqual({
      kind: "discarded",
      to: fixture.target,
      leftover: [],
    });
    expect(exists(stagingFor(fixture.target))).toBe(false);
    expect(exists(fixture.journalFile)).toBe(false);
    expect(snapshot(fixture.source)).toEqual(before);
    expect(pointer()).toBeNull();
  });

  it("killed between the rename and the pointer write: the unreferenced copy is removed", async () => {
    await moveUntil(
      (operation, path) =>
        operation === "writeFileAtomic" && path === fixture.locationFile,
    );
    // A complete, verified copy under the target's name, and no pointer.
    expect(exists(join(fixture.target, "config.json"))).toBe(true);
    expect(pointer()).toBeNull();

    expect(await recover(pointer())).toEqual({
      kind: "discarded",
      to: fixture.target,
      leftover: [],
    });
    expect(exists(fixture.target)).toBe(false);
    expect(exists(fixture.journalFile)).toBe(false);
    expect(snapshot(fixture.source)).toEqual(before);
  });

  it("killed right after the pointer write: the move stands and is tidied up", async () => {
    await moveUntil(
      (operation, path) =>
        operation === "writeFileAtomic" &&
        path.endsWith("moved-elsewhere.json"),
    );
    const location = pointer();
    expect(location?.dataDir).toBe(fixture.target);

    expect(await recover(location)).toEqual({
      kind: "completed",
      to: fixture.target,
    });
    expect(snapshot(fixture.target)).toEqual(movedSnapshot(fixture.source));
    expect(exists(join(fixture.source, "moved-elsewhere.json"))).toBe(true);
    expect(exists(fixture.journalFile)).toBe(false);
    // Running it again changes nothing.
    expect(await recover(location)).toEqual({ kind: "none" });
  });

  it("never removes a folder that does not carry the move's marker", async () => {
    await moveUntil(
      (operation, path) =>
        operation === "writeFileAtomic" && path === fixture.locationFile,
    );
    // The person replaced the unfinished copy with a folder of their own.
    rmSync(fixture.target, { recursive: true });
    mkdirSync(fixture.target);
    writeFileSync(join(fixture.target, "thesis.docx"), "years of work");

    expect(await recover(null)).toMatchObject({ kind: "discarded" });
    expect(snapshot(fixture.target)).toEqual({
      "thesis.docx": "years of work",
    });
  });

  it("keeps the journal when the copy cannot be removed, so the next launch tries again", async () => {
    await moveUntil(
      (operation, path) => operation === "copyFile" && path.endsWith("2619"),
    );
    const result = await recoverInterruptedMove({
      fs: {
        ...nodeMoveFs,
        removeTree: async () => {
          throw new Error("EBUSY");
        },
      },
      path: posix,
      journalFile: fixture.journalFile,
      location: null,
      log: () => undefined,
    });
    expect(result).toEqual({
      kind: "discarded",
      to: fixture.target,
      leftover: [stagingFor(fixture.target)],
    });
    expect(exists(fixture.journalFile)).toBe(true);
  });

  it("acts on nothing when the journal cannot be read", async () => {
    mkdirSync(stagingFor(fixture.target));
    writeFileSync(fixture.journalFile, "{ not json");
    expect(await recover(null)).toEqual({ kind: "unreadable-journal" });
    expect(exists(stagingFor(fixture.target))).toBe(true);
  });
});
