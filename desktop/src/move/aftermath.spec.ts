import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join, posix } from "path";

import {
  createMoveFixture,
  exists,
  movedSnapshot,
  MoveFixture,
  snapshot,
} from "../test-support/move-fixture";
import {
  AftermathDeps,
  canRollBack,
  confirmMove,
  forgetOldCopy,
  removeOldCopy,
  rollbackMove,
} from "./aftermath";
import { DataLocation, readLocationSync } from "./location";
import { runMove } from "./move";
import { nodeMoveFs } from "./move-fs";
import { MoveFs } from "./move-types";

describe("after a move", () => {
  let fixture: MoveFixture;
  let original: Record<string, string>;
  beforeEach(async () => {
    fixture = createMoveFixture();
    original = snapshot(fixture.source);
    await runMove(fixture.deps(), {
      id: "move-1",
      source: fixture.source,
      target: fixture.target,
      now: new Date("2026-11-13T10:00:00.000Z"),
    });
  });
  afterEach(() => fixture.cleanup());

  const deps = (fs: MoveFs = nodeMoveFs): AftermathDeps => ({
    fs,
    path: posix,
    platform: process.platform,
    locationFile: fixture.locationFile,
    log: (line) => fixture.logs.push(line),
  });
  const pointer = (): DataLocation =>
    readLocationSync(fixture.locationFile, process.platform) as DataLocation;
  const NOW = new Date("2026-11-13T11:00:00.000Z");
  const tombstoneIn = (dir: string) => join(dir, "moved-elsewhere.json");

  describe("confirmMove", () => {
    it("marks the move confirmed once the new folder has started", async () => {
      const confirmed = await confirmMove(deps(), pointer());
      expect(confirmed.state).toBe("confirmed");
      expect(pointer()).toEqual({
        ...confirmed,
        previousDataDir: fixture.source,
      });
      expect(await canRollBack(deps(), pointer())).toBe(false);
    });

    it("writes the note in the old folder when the move was killed before it could", async () => {
      rmSync(tombstoneIn(fixture.source));
      await confirmMove(deps(), pointer());
      expect(exists(tombstoneIn(fixture.source))).toBe(true);
    });

    it("writes nothing on later starts", async () => {
      const confirmed = await confirmMove(deps(), pointer());
      const writeFileAtomic = jest.fn(nodeMoveFs.writeFileAtomic);
      await confirmMove(deps({ ...nodeMoveFs, writeFileAtomic }), {
        ...confirmed,
        previousDataDir: null,
      });
      expect(writeFileAtomic).not.toHaveBeenCalled();
    });
  });

  describe("rollbackMove (the new folder fails to start)", () => {
    it("is offered only while the new folder has never started", async () => {
      expect(await canRollBack(deps(), pointer())).toBe(true);
      expect(await canRollBack(deps(), null)).toBe(false);
      rmSync(join(fixture.source, "config.json"));
      expect(await canRollBack(deps(), pointer())).toBe(false);
    });

    it("makes the previous folder the data folder again and keeps the new one", async () => {
      const result = await rollbackMove(deps(), pointer(), NOW);

      expect(result).toEqual({ kind: "rolled-back", dataDir: fixture.source });
      expect(pointer()).toEqual({
        dataDir: fixture.source,
        previousDataDir: null,
        state: "confirmed",
        movedAt: NOW.toISOString(),
      });
      // The previous folder is exactly what it was before the move.
      expect(snapshot(fixture.source)).toEqual(original);
      // The new one is kept, and marked so it cannot be opened by mistake.
      const { "moved-elsewhere.json": note, ...kept } = snapshot(
        fixture.target,
      );
      expect(kept).toEqual(movedSnapshot(fixture.source));
      expect(JSON.parse(note)).toMatchObject({ movedTo: fixture.source });
    });

    it("refuses while a database server has the new folder open", async () => {
      writeFileSync(join(fixture.target, "pgdata", "postmaster.pid"), "1\n");
      const result = await rollbackMove(deps(), pointer(), NOW);
      expect(result.kind).toBe("refused");
      expect(pointer().dataDir).toBe(fixture.target);
      expect(exists(tombstoneIn(fixture.source))).toBe(true);
    });

    it("refuses once the move is confirmed", async () => {
      const confirmed = await confirmMove(deps(), pointer());
      expect((await rollbackMove(deps(), confirmed, NOW)).kind).toBe("refused");
      expect(pointer().dataDir).toBe(fixture.target);
    });

    it("a failed pointer write leaves the new folder current", async () => {
      const result = await rollbackMove(
        deps({
          ...nodeMoveFs,
          async writeFileAtomic(path, data) {
            if (path === fixture.locationFile) throw new Error("EACCES");
            return nodeMoveFs.writeFileAtomic(path, data);
          },
        }),
        pointer(),
        NOW,
      );
      expect(result).toEqual({ kind: "refused", message: "EACCES" });
      expect(pointer().dataDir).toBe(fixture.target);
      expect(exists(tombstoneIn(fixture.target))).toBe(false);
    });
  });

  describe("removeOldCopy", () => {
    it("refuses before the new folder has started", async () => {
      expect((await removeOldCopy(deps(), pointer())).kind).toBe("refused");
      expect(snapshot(fixture.source)).toMatchObject(original);
    });

    it("deletes what Monize created, the folder with it, and stops offering", async () => {
      const confirmed = await confirmMove(deps(), pointer());
      expect(await removeOldCopy(deps(), confirmed)).toEqual({
        kind: "removed",
        folderGone: true,
      });
      expect(exists(fixture.source)).toBe(false);
      expect(pointer().previousDataDir).toBeNull();
      expect(snapshot(fixture.target)).toEqual(movedSnapshot(fixture.target));
      expect(exists(join(fixture.target, "config.json"))).toBe(true);
    });

    it("leaves a file the person put in the old folder, and the folder with it", async () => {
      writeFileSync(join(fixture.source, "my-notes.txt"), "mine");
      const confirmed = await confirmMove(deps(), pointer());
      expect(await removeOldCopy(deps(), confirmed)).toEqual({
        kind: "removed",
        folderGone: false,
      });
      expect(snapshot(fixture.source)).toEqual({ "my-notes.txt": "mine" });
    });

    it("refuses a folder that is not marked as the copy this data came from", async () => {
      const confirmed = await confirmMove(deps(), pointer());
      rmSync(tombstoneIn(fixture.source));
      expect((await removeOldCopy(deps(), confirmed)).kind).toBe("refused");
      writeFileSync(
        tombstoneIn(fixture.source),
        JSON.stringify({ version: 1, movedTo: "/elsewhere", movedAt: "x" }),
      );
      expect((await removeOldCopy(deps(), confirmed)).kind).toBe("refused");
      expect(exists(join(fixture.source, "pgdata", "PG_VERSION"))).toBe(true);
    });

    it("refuses a folder that is, contains or is inside the current one", async () => {
      const confirmed = await confirmMove(deps(), pointer());
      for (const previousDataDir of [
        fixture.target,
        join(fixture.target, "pgdata"),
        posix.dirname(fixture.target),
      ]) {
        const result = await removeOldCopy(deps(), {
          ...confirmed,
          previousDataDir,
        });
        expect(result.kind).toBe("refused");
      }
      expect(snapshot(fixture.target)).toEqual(movedSnapshot(fixture.target));
    });

    it("stopped halfway, it leaves a folder still marked as moved, and offers again", async () => {
      const confirmed = await confirmMove(deps(), pointer());
      const result = await removeOldCopy(
        deps({
          ...nodeMoveFs,
          async removeTree(path) {
            if (path.endsWith("logs")) throw new Error("EBUSY");
            return nodeMoveFs.removeTree(path);
          },
        }),
        confirmed,
      );
      expect(result).toEqual({ kind: "failed", message: "EBUSY" });
      expect(exists(tombstoneIn(fixture.source))).toBe(true);
      expect(pointer().previousDataDir).toBe(fixture.source);
    });

    it("forgets an old copy that is already gone", async () => {
      const confirmed = await confirmMove(deps(), pointer());
      rmSync(fixture.source, { recursive: true });
      expect((await removeOldCopy(deps(), confirmed)).kind).toBe("removed");
      expect(pointer().previousDataDir).toBeNull();
    });

    it("keeping the old copy stops the offer and deletes nothing", async () => {
      const confirmed = await confirmMove(deps(), pointer());
      const kept = await forgetOldCopy(deps(), confirmed);
      expect(kept.previousDataDir).toBeNull();
      expect(pointer()).toEqual(kept);
      expect(exists(join(fixture.source, "pgdata", "PG_VERSION"))).toBe(true);
      mkdirSync(join(fixture.source, "still-here"));
    });
  });
});
