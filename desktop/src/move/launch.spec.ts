import { AppPathsInput } from "../app-paths";
import { LaunchProbe, launchVerdict, resolveLaunchPaths } from "./launch";
import { DataLocation, LocationError } from "./location";

const input = (env: Record<string, string> = {}): AppPathsInput => ({
  env,
  platform: "linux",
  isPackaged: false,
  resourcesPath: "",
  desktopRoot: "/repo/desktop",
  homeDir: "/home/a",
});
const DEFAULT = "/home/a/.local/share/Monize";
const MOVED: DataLocation = {
  dataDir: "/mnt/big/Monize",
  previousDataDir: DEFAULT,
  state: "pending",
  movedAt: "2026-11-13T10:00:00.000Z",
};

function probe(files: Readonly<Record<string, string>>): LaunchProbe {
  return {
    exists: (path) => path in files,
    read: (path) => (path in files ? Buffer.from(files[path]) : null),
  };
}

describe("resolveLaunchPaths", () => {
  it("uses the default folder, and keeps a move's records beside it", () => {
    const read = jest.fn(() => null);
    const launch = resolveLaunchPaths(input(), read);
    expect(launch.origin).toBe("default");
    expect(launch.paths.data.dataDir).toBe(DEFAULT);
    expect(launch.records).toEqual({
      defaultDataDir: DEFAULT,
      locationFile: `${DEFAULT}-location.ini`,
      journalFile: `${DEFAULT}-move.json`,
    });
    expect(read).toHaveBeenCalledWith(`${DEFAULT}-location.ini`, "linux");
  });

  it("follows the pointer", () => {
    const launch = resolveLaunchPaths(input(), () => MOVED);
    expect(launch).toMatchObject({ origin: "pointer", location: MOVED });
    expect(launch.paths.data.pgdata).toBe("/mnt/big/Monize/pgdata");
  });

  it("MONIZE_DATA_DIR wins and the pointer is not even read", () => {
    const read = jest.fn(() => MOVED);
    const launch = resolveLaunchPaths(
      input({ MONIZE_DATA_DIR: "/tmp/one-launch" }),
      read,
    );
    expect(launch).toMatchObject({
      origin: "env",
      records: null,
      location: null,
    });
    expect(launch.paths.data.dataDir).toBe("/tmp/one-launch");
    expect(read).not.toHaveBeenCalled();
  });

  it("a pointer that cannot be read stops the launch", () => {
    expect(() =>
      resolveLaunchPaths(input(), () => {
        throw new LocationError("f", "damaged");
      }),
    ).toThrow(LocationError);
  });
});

describe("launchVerdict", () => {
  const moved = resolveLaunchPaths(input(), () => MOVED);

  it("starts a folder that holds its config", () => {
    expect(
      launchVerdict(
        moved,
        "linux",
        probe({ "/mnt/big/Monize/config.json": "" }),
      ),
    ).toEqual({ kind: "ok" });
  });

  it("starts the default folder on a first run, when nothing is there yet", () => {
    expect(
      launchVerdict(
        resolveLaunchPaths(input(), () => null),
        "linux",
        probe({}),
      ),
    ).toEqual({ kind: "ok" });
  });

  it("refuses a moved folder that is not there, rather than create an empty one", () => {
    expect(
      launchVerdict(moved, "linux", probe({ [`${DEFAULT}/config.json`]: "" })),
    ).toEqual({ kind: "missing", dataDir: "/mnt/big/Monize", canGoBack: true });
  });

  it("offers no way back once the move was confirmed, or the old copy is gone", () => {
    const confirmed = resolveLaunchPaths(input(), () => ({
      ...MOVED,
      state: "confirmed",
    }));
    const old = probe({ [`${DEFAULT}/config.json`]: "" });
    expect(launchVerdict(confirmed, "linux", old)).toMatchObject({
      kind: "missing",
      canGoBack: false,
    });
    expect(launchVerdict(moved, "linux", probe({}))).toMatchObject({
      kind: "missing",
      canGoBack: false,
    });
  });

  it("refuses a folder whose data was moved away, however it was reached", () => {
    const note = JSON.stringify({
      version: 1,
      movedTo: "/mnt/big/Monize",
      movedAt: "2026-11-13T10:00:00.000Z",
    });
    const byHand = resolveLaunchPaths(input({ MONIZE_DATA_DIR: DEFAULT }));
    const files = probe({
      [`${DEFAULT}/moved-elsewhere.json`]: note,
      [`${DEFAULT}/config.json`]: "",
    });
    expect(launchVerdict(byHand, "linux", files)).toEqual({
      kind: "moved-away",
      dataDir: DEFAULT,
      movedTo: "/mnt/big/Monize",
    });
    const lostPointer = resolveLaunchPaths(input(), () => null);
    expect(launchVerdict(lostPointer, "linux", files).kind).toBe("moved-away");
  });

  it("refuses on a damaged note too", () => {
    const launch = resolveLaunchPaths(input(), () => null);
    expect(
      launchVerdict(
        launch,
        "linux",
        probe({ [`${DEFAULT}/moved-elsewhere.json`]: "{" }),
      ),
    ).toEqual({ kind: "moved-away", dataDir: DEFAULT, movedTo: "" });
  });
});
