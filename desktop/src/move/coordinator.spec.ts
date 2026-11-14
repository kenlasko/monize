import { writeFileSync } from "fs";
import { join } from "path";

import {
  createMoveFixture,
  exists,
  MoveFixture,
  snapshot,
} from "../test-support/move-fixture";
import {
  CoordinatorDeps,
  createMoveCoordinator,
  MoveCoordinator,
  MoveUi,
} from "./coordinator";
import { LaunchPaths } from "./launch";
import { readLocationSync } from "./location";
import { nodeMoveFs } from "./move-fs";
import { stagingFor } from "./target";
import { withFault } from "./test-faults";

describe("the move coordinator", () => {
  let fixture: MoveFixture;
  let events: string[];
  let quitting: boolean;
  beforeEach(() => {
    fixture = createMoveFixture();
    events = [];
    quitting = false;
  });
  afterEach(() => fixture.cleanup());

  function launch(overrides: Partial<LaunchPaths> = {}): LaunchPaths {
    return {
      paths: {
        resourcesDir: "/resources",
        data: {
          dataDir: fixture.source,
          pgdata: join(fixture.source, "pgdata"),
          backups: join(fixture.source, "backups"),
          attachments: join(fixture.source, "attachments"),
          logs: join(fixture.source, "logs"),
          configFile: join(fixture.source, "config.json"),
        },
      },
      origin: "default",
      records: {
        defaultDataDir: fixture.source,
        locationFile: fixture.locationFile,
        journalFile: fixture.journalFile,
      },
      location: null,
      ...overrides,
    };
  }

  function ui(overrides: Partial<MoveUi> = {}): MoveUi {
    return {
      notMovable: async (reason) => void events.push(`not-movable:${reason}`),
      pickFolder: async () => {
        events.push("pick");
        return fixture.target;
      },
      targetRefused: async (verdict) =>
        void events.push(`refused:${verdict.problem}`),
      confirm: async (plan) => {
        events.push(`confirm:${plan.files}:${plan.target}`);
        return true;
      },
      progress: (progress) => {
        if (events[events.length - 1] !== `progress:${progress.phase}`) {
          events.push(`progress:${progress.phase}`);
        }
      },
      moveFailed: async (outcome) =>
        void events.push(
          `failed:${outcome.kind === "failed" ? outcome.failure : outcome.kind}`,
        ),
      ...overrides,
    };
  }

  function deps(overrides: Partial<CoordinatorDeps> = {}): CoordinatorDeps {
    return {
      launch: launch(),
      platform: "linux",
      fs: nodeMoveFs,
      installDir: null,
      ui: ui(),
      stopStack: async () => void events.push("stop-stack"),
      isQuitting: () => quitting,
      isUpdateBusy: () => false,
      beginMove: () => void events.push("begin"),
      relaunch: () => void events.push("relaunch"),
      newId: () => "move-1",
      now: () => new Date("2026-11-13T10:00:00.000Z"),
      writeLog: (dataDir, lines) =>
        void events.push(`log:${dataDir}:${lines.length > 0}`),
      ...overrides,
    };
  }

  it("asks, checks, confirms, stops the stack, moves, then restarts", async () => {
    await createMoveCoordinator(deps()).start();

    expect(events).toEqual([
      "pick",
      // 9 files: the data, and of the Chromium profile only its key file.
      `confirm:9:${fixture.target}`,
      "begin",
      "progress:stopping",
      "stop-stack",
      "progress:preparing",
      "progress:copying",
      "progress:verifying",
      "progress:switching",
      `log:${fixture.target}:true`,
      "relaunch",
    ]);
    expect(readLocationSync(fixture.locationFile, "linux")?.dataDir).toBe(
      fixture.target,
    );
  });

  it("does nothing under MONIZE_DATA_DIR but say why", async () => {
    await createMoveCoordinator(
      deps({ launch: launch({ origin: "env", records: null }) }),
    ).start();
    expect(events).toEqual(["not-movable:env-override"]);
  });

  it("does not start beside an update", async () => {
    await createMoveCoordinator(deps({ isUpdateBusy: () => true })).start();
    expect(events).toEqual(["not-movable:update-running"]);
  });

  it("does not start while the last move's old copy is undecided", async () => {
    await createMoveCoordinator(
      deps({
        readLocation: () => ({
          dataDir: fixture.source,
          previousDataDir: "/somewhere/else",
          state: "confirmed",
          movedAt: "2026-11-13T10:00:00.000Z",
        }),
      }),
    ).start();
    expect(events).toEqual(["not-movable:old-copy-pending"]);
  });

  it.each([
    ["the picker is closed", { pickFolder: async () => null }, []],
    [
      "the folder is refused",
      { pickFolder: async () => "/" },
      ["refused:root"],
    ],
    ["the person says no", { confirm: async () => false }, ["pick"]],
  ])("leaves Monize running when %s", async (_name, overrides, expected) => {
    await createMoveCoordinator(deps({ ui: ui(overrides) })).start();
    expect(events).toEqual(expected);
    expect(exists(fixture.locationFile)).toBe(false);
  });

  it("refuses a folder that holds files, before anything is stopped", async () => {
    const mine = join(fixture.root, "disk two");
    writeFileSync(join(mine, "file.txt"), "mine");
    await createMoveCoordinator(
      deps({ ui: ui({ pickFolder: async () => mine }) }),
    ).start();
    expect(events).toEqual(["refused:not-empty"]);
  });

  it("a failed move says so, then restarts on the old folder", async () => {
    const before = snapshot(fixture.source);
    await createMoveCoordinator(
      deps({ fs: withFault(nodeMoveFs, "verify") }),
    ).start();

    expect(events.slice(-3)).toEqual([
      `log:${fixture.source}:true`,
      "failed:verify-mismatch",
      "relaunch",
    ]);
    expect(snapshot(fixture.source)).toEqual(before);
    expect(exists(fixture.locationFile)).toBe(false);
    expect(exists(stagingFor(fixture.target))).toBe(false);
  });

  it("a stack that will not stop is not copied from", async () => {
    await createMoveCoordinator(
      deps({
        stopStack: async () => {
          throw new Error("stop failed");
        },
      }),
    ).start();
    expect(events.slice(-2)).toEqual(["failed:uncertain", "relaunch"]);
    expect(exists(stagingFor(fixture.target))).toBe(false);
  });

  it("a quit during the copy abandons it, waits for the cleanup, and does not restart", async () => {
    let waited: Promise<void> | undefined;
    const coordinator: MoveCoordinator = createMoveCoordinator(
      deps({
        fs: {
          ...nodeMoveFs,
          async copyFile(from, to, mode) {
            if (waited === undefined) {
              // The quit gate: cancel, then wait for the copy to be gone.
              quitting = true;
              coordinator.cancel();
              waited = coordinator.working().then(() => {
                events.push(
                  `quit-proceeds:staging=${exists(stagingFor(fixture.target))}`,
                );
              });
            }
            return nodeMoveFs.copyFile(from, to, mode);
          },
        },
      }),
    );
    await coordinator.start();
    await waited;

    expect(events).toContain("quit-proceeds:staging=false");
    expect(events).not.toContain("relaunch");
    expect(events.some((event) => event.startsWith("failed"))).toBe(false);
    expect(exists(fixture.locationFile)).toBe(false);
  });

  it("a quit while the confirmation is open stops nothing and moves nothing", async () => {
    await createMoveCoordinator(
      deps({
        ui: ui({
          confirm: async () => {
            quitting = true;
            return true;
          },
        }),
      }),
    ).start();
    expect(events).toEqual(["pick"]);
  });

  it("ignores a second click while the first is under way", async () => {
    const coordinator = createMoveCoordinator(deps());
    await Promise.all([coordinator.start(), coordinator.start()]);
    expect(events.filter((event) => event === "pick")).toHaveLength(1);
  });

  it("has nothing to wait for when no move runs", async () => {
    await expect(
      createMoveCoordinator(deps()).working(),
    ).resolves.toBeUndefined();
  });
});
