import { rmSync, writeFileSync } from "fs";
import { join, posix } from "path";

import {
  createMoveFixture,
  exists,
  MoveFixture,
  snapshot,
} from "../test-support/move-fixture";
import {
  AfterRestartDeps,
  AfterRestartUi,
  CleanupChoice,
  createAfterRestart,
} from "./after-restart";
import { resolveLaunchPaths } from "./launch";
import { DataLocation, readLocationSync } from "./location";
import { runMove } from "./move";
import { nodeMoveFs } from "./move-fs";
import { writeJournal } from "./records";
import { stagingFor } from "./target";

describe("the launch after a move", () => {
  let fixture: MoveFixture;
  let events: string[];
  let original: Record<string, string>;
  beforeEach(() => {
    fixture = createMoveFixture();
    events = [];
    original = snapshot(fixture.source);
  });
  afterEach(() => fixture.cleanup());

  const move = () =>
    runMove(fixture.deps(), {
      id: "move-1",
      source: fixture.source,
      target: fixture.target,
      now: new Date("2026-11-13T10:00:00.000Z"),
    });
  const pointer = () => readLocationSync(fixture.locationFile, "linux");

  function subject(
    answers: { rollback?: boolean; cleanup?: CleanupChoice } = {},
    overrides: Partial<AfterRestartDeps> = {},
  ) {
    const ui: AfterRestartUi = {
      interrupted: async (result, current) =>
        void events.push(`interrupted:${result.to}:${current}`),
      offerRollback: async (current, previous) => {
        events.push(`offer-rollback:${current}:${previous}`);
        return answers.rollback ?? false;
      },
      rollbackRefused: async () => void events.push("rollback-refused"),
      offerCleanup: async (_current, old) => {
        events.push(`offer-cleanup:${old}`);
        return answers.cleanup ?? "later";
      },
      cleanupResult: async (result) =>
        void events.push(`cleanup:${result.kind}`),
    };
    // What the shell does: resolve the folder from the pointer on disk.
    const launch = resolveLaunchPaths({
      env: { XDG_DATA_HOME: posix.dirname(fixture.source) },
      platform: "linux",
      isPackaged: false,
      resourcesPath: "",
      desktopRoot: "/repo/desktop",
      homeDir: "/home/a",
    });
    return createAfterRestart({
      launch,
      platform: "linux",
      path: posix,
      fs: nodeMoveFs,
      ui,
      stopStack: async () => void events.push("stop-stack"),
      isQuitting: () => false,
      relaunch: () => void events.push("relaunch"),
      now: () => new Date("2026-11-13T11:00:00.000Z"),
      log: (line) => fixture.logs.push(line),
      ...overrides,
    });
  }

  it("does nothing at all for an install that never moved", async () => {
    const after = subject();
    await after.recover();
    await after.bootFailed();
    await after.stackReady();
    expect(events).toEqual([]);
    expect(exists(fixture.locationFile)).toBe(false);
  });

  it("new location fails to boot, then rollback: the previous folder is current again", async () => {
    await move();
    const after = subject({ rollback: true });
    await after.bootFailed();

    expect(events).toEqual([
      `offer-rollback:${fixture.target}:${fixture.source}`,
      "stop-stack",
      "relaunch",
    ]);
    expect(pointer()).toMatchObject({
      dataDir: fixture.source,
      previousDataDir: null,
    });
    expect(snapshot(fixture.source)).toEqual(original);
    // Kept for inspection, never deleted.
    expect(exists(join(fixture.target, "pgdata", "PG_VERSION"))).toBe(true);
  });

  it("staying put changes nothing, and the offer comes back on the next failure", async () => {
    await move();
    const after = subject({ rollback: false });
    await after.bootFailed();
    await after.bootFailed();
    expect(events).toEqual([
      `offer-rollback:${fixture.target}:${fixture.source}`,
      `offer-rollback:${fixture.target}:${fixture.source}`,
    ]);
    expect(pointer()?.dataDir).toBe(fixture.target);
  });

  it("asks once at a time", async () => {
    await move();
    const after = subject();
    await Promise.all([after.bootFailed(), after.bootFailed()]);
    expect(events).toHaveLength(1);
  });

  it("a refused rollback is said, and the shell restarts where it was", async () => {
    await move();
    writeFileSync(join(fixture.target, "pgdata", "postmaster.pid"), "1\n");
    await subject({ rollback: true }).bootFailed();
    expect(events.slice(-3)).toEqual([
      "stop-stack",
      "rollback-refused",
      "relaunch",
    ]);
    expect(pointer()?.dataDir).toBe(fixture.target);
  });

  it("offers no way back once the folder has started", async () => {
    await move();
    const after = subject();
    await after.stackReady();
    events.length = 0;
    await after.bootFailed();
    expect(events).toEqual([]);
  });

  it("first start on the new folder confirms the move and only offers the cleanup", async () => {
    await move();
    await subject({ cleanup: "later" }).stackReady();

    expect(events).toEqual([`offer-cleanup:${fixture.source}`]);
    expect(pointer()).toMatchObject({
      state: "confirmed",
      previousDataDir: fixture.source,
    });
    expect(exists(join(fixture.source, "pgdata", "PG_VERSION"))).toBe(true);
    // The marker stays, so the next launch offers again.
    events.length = 0;
    await subject({ cleanup: "later" }).stackReady();
    expect(events).toEqual([`offer-cleanup:${fixture.source}`]);
  });

  it("deletes the old copy only on the person's word", async () => {
    await move();
    await subject({ cleanup: "delete" }).stackReady();
    expect(events).toEqual([
      `offer-cleanup:${fixture.source}`,
      "cleanup:removed",
    ]);
    expect(exists(fixture.source)).toBe(false);
    expect(pointer()?.previousDataDir).toBeNull();
    events.length = 0;
    await subject().stackReady();
    expect(events).toEqual([]);
  });

  it("keeping the old copy ends the offers", async () => {
    await move();
    await subject({ cleanup: "keep" }).stackReady();
    expect(exists(join(fixture.source, "config.json"))).toBe(true);
    events.length = 0;
    await subject().stackReady();
    expect(events).toEqual([]);
  });

  it("stops offering when the old copy was deleted by hand", async () => {
    await move();
    rmSync(fixture.source, { recursive: true });
    await subject().stackReady();
    expect(events).toEqual([]);
    expect(pointer()).toMatchObject({
      dataDir: fixture.target,
      previousDataDir: null,
    });
  });

  it("crash between rename and pointer write, found on next launch: discarded and said", async () => {
    // What such a crash leaves: the journal, and a copy under the target's
    // name still carrying the move's marker. No pointer.
    await move();
    rmSync(fixture.locationFile);
    rmSync(join(fixture.source, "moved-elsewhere.json"));
    writeFileSync(join(fixture.target, ".monize-move"), "move-1\n");
    await writeJournal(nodeMoveFs, fixture.journalFile, {
      id: "move-1",
      from: fixture.source,
      to: fixture.target,
      staging: stagingFor(fixture.target),
      startedAt: "2026-11-13T10:00:00.000Z",
    });

    const after = subject();
    await after.recover();
    await Promise.resolve();

    expect(events).toEqual([`interrupted:${fixture.target}:${fixture.source}`]);
    expect(exists(fixture.target)).toBe(false);
    expect(exists(fixture.journalFile)).toBe(false);
    expect(snapshot(fixture.source)).toEqual(original);
    expect(pointer()).toBeNull();
  });

  it("recovery never rejects", async () => {
    const after = subject(
      {},
      {
        fs: {
          ...nodeMoveFs,
          readFile: async () => {
            throw new Error("EIO");
          },
        },
      },
    );
    await expect(after.recover()).resolves.toBeUndefined();
  });

  it("a confirmation that cannot be written is logged, not thrown", async () => {
    await move();
    const location = pointer() as DataLocation;
    const after = subject(
      {},
      {
        fs: {
          ...nodeMoveFs,
          writeFileAtomic: async () => {
            throw new Error("EACCES");
          },
        },
      },
    );
    await expect(after.stackReady()).resolves.toBeUndefined();
    expect(pointer()).toEqual(location);
    expect(fixture.logs.join("\n")).toContain("EACCES");
  });
});
