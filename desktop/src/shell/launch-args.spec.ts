import {
  instanceData,
  launchRequestFrom,
  QUIT_FLAG,
  secondInstanceAction,
} from "./launch-args";

const EXE = "C:\\Program Files\\Monize\\Monize.exe";

describe("launchRequestFrom", () => {
  it("reads --quit and a deep link", () => {
    expect(launchRequestFrom([EXE, QUIT_FLAG])).toEqual({
      quit: true,
      deepLink: null,
    });
    expect(launchRequestFrom([EXE, "monize://open/accounts"])).toEqual({
      quit: false,
      deepLink: "monize://open/accounts",
    });
  });

  it("does not take a lookalike for --quit", () => {
    expect(launchRequestFrom([EXE, "--quiet", "--quit=no"]).quit).toBe(false);
  });
});

describe("secondInstanceAction", () => {
  it("prefers the additional data the second launch sent", () => {
    const data = instanceData({ quit: true, deepLink: null });
    expect(secondInstanceAction([EXE], data)).toEqual({ kind: "quit" });
  });

  it("falls back to the forwarded argv", () => {
    expect(secondInstanceAction([EXE, QUIT_FLAG], undefined)).toEqual({
      kind: "quit",
    });
    expect(
      secondInstanceAction(
        [EXE, "--some-chromium-switch", "monize://open/x"],
        {},
      ),
    ).toEqual({ kind: "deep-link", raw: "monize://open/x" });
  });

  it("passes a deep link on unvalidated, for the parser to judge", () => {
    const data = instanceData({ quit: false, deepLink: "monize://evil/x" });
    expect(secondInstanceAction([EXE], data)).toEqual({
      kind: "deep-link",
      raw: "monize://evil/x",
    });
  });

  it("focuses for a plain second launch", () => {
    expect(
      secondInstanceAction(
        [EXE],
        instanceData({ quit: false, deepLink: null }),
      ),
    ).toEqual({ kind: "focus" });
    expect(secondInstanceAction([EXE], null)).toEqual({ kind: "focus" });
  });

  it("ignores additional data of the wrong shape", () => {
    expect(
      secondInstanceAction([EXE], { monize: 1, quit: "yes", deepLink: 5 }),
    ).toEqual({ kind: "focus" });
  });
});
