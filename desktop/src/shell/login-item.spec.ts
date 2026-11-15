import {
  LOGIN_LAUNCH_ARG,
  loginItemOffered,
  loginItemSettings,
  showSplashView,
  showWindowOnReady,
  startedAtLogin,
} from "./login-item";

describe("loginItemOffered", () => {
  it("offers it only to a packaged app on Windows", () => {
    expect(loginItemOffered({ platform: "win32", isPackaged: true })).toBe(
      true,
    );
    expect(loginItemOffered({ platform: "win32", isPackaged: false })).toBe(
      false,
    );
    expect(loginItemOffered({ platform: "linux", isPackaged: true })).toBe(
      false,
    );
    expect(loginItemOffered({ platform: "darwin", isPackaged: true })).toBe(
      false,
    );
  });
});

describe("loginItemSettings", () => {
  it("marks the launch whether the item is on or off", () => {
    expect(loginItemSettings(true)).toEqual({
      openAtLogin: true,
      args: [LOGIN_LAUNCH_ARG],
    });
    expect(loginItemSettings(false)).toEqual({
      openAtLogin: false,
      args: [LOGIN_LAUNCH_ARG],
    });
  });
});

describe("startedAtLogin", () => {
  it("is true for the marker argument", () => {
    expect(
      startedAtLogin({
        argv: ["Monize.exe", LOGIN_LAUNCH_ARG],
        wasOpenedAtLogin: false,
      }),
    ).toBe(true);
  });

  it("is true when Electron says it was opened at login", () => {
    expect(
      startedAtLogin({ argv: ["Monize.exe"], wasOpenedAtLogin: true }),
    ).toBe(true);
  });

  it("is false for an ordinary launch", () => {
    expect(
      startedAtLogin({ argv: ["Monize.exe"], wasOpenedAtLogin: false }),
    ).toBe(false);
  });
});

describe("showWindowOnReady", () => {
  it("shows an ordinary launch", () => {
    expect(
      showWindowOnReady({ startedAtLogin: false, trayAvailable: true }),
    ).toBe(true);
  });

  it("keeps a login launch in the tray", () => {
    expect(
      showWindowOnReady({ startedAtLogin: true, trayAvailable: true }),
    ).toBe(false);
  });

  it("shows a login launch when there is no tray to reach it from", () => {
    expect(
      showWindowOnReady({ startedAtLogin: true, trayAvailable: false }),
    ).toBe(true);
  });
});

describe("showSplashView", () => {
  it("hides only the busy splash of a login launch", () => {
    expect(showSplashView({ startedAtLogin: true, busy: true })).toBe(false);
    expect(showSplashView({ startedAtLogin: true, busy: false })).toBe(true);
    expect(showSplashView({ startedAtLogin: false, busy: true })).toBe(true);
  });
});
