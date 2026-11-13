import {
  AppPathsError,
  AppPathsInput,
  dataPathsFor,
  resolveAppPaths,
  resolveDataDir,
  resolveResourcesDir,
} from "./app-paths";

function input(overrides: Partial<AppPathsInput> = {}): AppPathsInput {
  return {
    env: {},
    platform: "linux",
    isPackaged: false,
    resourcesPath: "/opt/Monize/resources",
    desktopRoot: "/repo/desktop",
    homeDir: "/home/user",
    ...overrides,
  };
}

describe("resolveResourcesDir", () => {
  it("uses the Electron resources path when packaged", () => {
    expect(resolveResourcesDir(input({ isPackaged: true }))).toBe(
      "/opt/Monize/resources",
    );
  });

  it("uses desktop/staging in development", () => {
    expect(resolveResourcesDir(input())).toBe("/repo/desktop/staging");
  });

  it("joins with Windows separators on win32", () => {
    expect(
      resolveResourcesDir(
        input({ platform: "win32", desktopRoot: "C:\\src\\monize\\desktop" }),
      ),
    ).toBe("C:\\src\\monize\\desktop\\staging");
  });
});

describe("resolveDataDir", () => {
  it("prefers MONIZE_DATA_DIR on every platform", () => {
    expect(
      resolveDataDir(
        input({
          platform: "win32",
          env: { MONIZE_DATA_DIR: "D:\\Data\\Monize", LOCALAPPDATA: "C:\\x" },
        }),
      ),
    ).toBe("D:\\Data\\Monize");
    expect(resolveDataDir(input({ env: { MONIZE_DATA_DIR: "/tmp/m" } }))).toBe(
      "/tmp/m",
    );
  });

  it("refuses a relative MONIZE_DATA_DIR", () => {
    expect(() =>
      resolveDataDir(input({ env: { MONIZE_DATA_DIR: "data" } })),
    ).toThrow(AppPathsError);
  });

  it("uses %LOCALAPPDATA%\\Monize on Windows", () => {
    expect(
      resolveDataDir(
        input({
          platform: "win32",
          env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
        }),
      ),
    ).toBe("C:\\Users\\a\\AppData\\Local\\Monize");
  });

  it("refuses Windows without LOCALAPPDATA", () => {
    expect(() => resolveDataDir(input({ platform: "win32" }))).toThrow(
      /LOCALAPPDATA/,
    );
  });

  it("uses XDG_DATA_HOME off Windows, ignoring a relative one", () => {
    expect(
      resolveDataDir(input({ env: { XDG_DATA_HOME: "/home/user/.data" } })),
    ).toBe("/home/user/.data/Monize");
    expect(resolveDataDir(input({ env: { XDG_DATA_HOME: "rel" } }))).toBe(
      "/home/user/.local/share/Monize",
    );
  });

  it("falls back to ~/.local/share/Monize", () => {
    expect(resolveDataDir(input())).toBe("/home/user/.local/share/Monize");
  });
});

describe("dataPathsFor", () => {
  it("lays out the plan D6 sub-paths", () => {
    expect(dataPathsFor("C:\\M", "win32")).toEqual({
      dataDir: "C:\\M",
      pgdata: "C:\\M\\pgdata",
      backups: "C:\\M\\backups",
      attachments: "C:\\M\\attachments",
      logs: "C:\\M\\logs",
      configFile: "C:\\M\\config.json",
    });
  });
});

describe("resolveAppPaths", () => {
  it("combines the resources dir and the data layout", () => {
    const paths = resolveAppPaths(input({ env: { MONIZE_DATA_DIR: "/d" } }));
    expect(paths.resourcesDir).toBe("/repo/desktop/staging");
    expect(paths.data.configFile).toBe("/d/config.json");
  });
});
