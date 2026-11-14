import {
  unattendedOptionsFrom,
  unattendedUi,
  withoutTestFlags,
} from "./unattended";

describe("the unattended move (development builds only)", () => {
  it("is off without a flag", () => {
    expect(unattendedOptionsFrom(["electron", ".", "--quit"])).toBeNull();
  });

  it("reads the target, a known fault and the answers", () => {
    expect(
      unattendedOptionsFrom([
        "electron",
        ".",
        "--test-move-to=/mnt/x",
        "--test-move-fault=verify",
        "--test-move-answers=rollback,delete",
      ]),
    ).toEqual({
      target: "/mnt/x",
      fault: "verify",
      answers: ["rollback", "delete"],
    });
    expect(unattendedOptionsFrom(["--test-move-fault=nonsense"])).toEqual({
      target: null,
      fault: null,
      answers: [],
    });
  });

  it("a restart does not repeat the move, and stays unattended", () => {
    expect(
      withoutTestFlags([
        ".",
        "--test-move-to=/mnt/x",
        "--test-move-fault=copy",
        "--test-move-answers=later",
        "monize://open/accounts",
      ]),
    ).toEqual([".", "--test-move-answers=later", "monize://open/accounts"]);
  });

  it("answers the dialogs as told, never deleting unless told to", async () => {
    const lines: string[] = [];
    const log = (line: string) => void lines.push(line);
    const quiet = unattendedUi({ target: "/x", fault: null, answers: [] }, log);
    expect(await quiet.pickFolder()).toBe("/x");
    expect(await quiet.offerRollback("/new", "/old")).toBe(false);
    expect(await quiet.offerCleanup("/new", "/old")).toBe("later");
    const told = unattendedUi(
      { target: null, fault: null, answers: ["rollback", "delete"] },
      log,
    );
    expect(await told.offerRollback("/new", "/old")).toBe(true);
    expect(await told.offerCleanup("/new", "/old")).toBe("delete");
    expect(lines.every((line) => line.startsWith("move (unattended):"))).toBe(
      true,
    );
  });
});
