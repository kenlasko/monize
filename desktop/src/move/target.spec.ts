import { mkdirSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";

import { createMoveFixture, MoveFixture } from "../test-support/move-fixture";
import { nodeMoveFs } from "./move-fs";
import {
  checkTargetPath,
  inspectTarget,
  neededBytesFor,
  relationOf,
  stagingFor,
  TargetRules,
} from "./target";

const WIN: TargetRules = {
  platform: "win32",
  source: "C:\\Users\\a\\AppData\\Local\\Monize",
  defaultDataDir: "C:\\Users\\a\\AppData\\Local\\Monize",
  installDir: "C:\\Users\\a\\AppData\\Local\\Programs\\Monize",
};

describe("relationOf", () => {
  it("compares whole names, and as Windows does", () => {
    expect(relationOf("C:\\a\\Monize", "c:\\A\\monize\\", "win32")).toBe(
      "same",
    );
    expect(relationOf("C:\\a\\Monize\\x", "C:\\a\\Monize", "win32")).toBe(
      "inside",
    );
    expect(relationOf("C:\\a", "C:\\a\\Monize", "win32")).toBe("contains");
    expect(relationOf("C:\\a\\Monize2", "C:\\a\\Monize", "win32")).toBe(
      "apart",
    );
    expect(relationOf("/a/Monize", "/a/monize", "linux")).toBe("apart");
    expect(relationOf("D:\\x", "D:\\", "win32")).toBe("inside");
  });
});

describe("checkTargetPath", () => {
  it.each([
    ["D:\\Monize", null],
    ["Monize", "not-absolute"],
    ["\\\\nas\\share\\Monize", "network"],
    ["D:\\", "root"],
    ['D:\\My "data"', "unstorable"],
    ["C:\\Users\\a\\AppData\\Local\\MONIZE", "same"],
    ["C:\\Users\\a\\AppData\\Local\\Monize\\pgdata\\x", "inside-data"],
    ["C:\\Users\\a\\AppData\\Local", "inside-data"],
    ["C:\\Users\\a\\AppData\\Local\\Programs\\Monize\\data", "inside-install"],
    ["C:\\Users\\a\\AppData\\Local\\Programs\\Monize", "inside-install"],
    ["C:\\Users\\a\\AppData\\Local\\Programs", "inside-install"],
  ])("%s -> %s", (target, problem) => {
    expect(checkTargetPath(target, WIN)).toBe(problem);
  });

  it("allows moving back to the default folder, and nothing inside it", () => {
    const moved: TargetRules = { ...WIN, source: "D:\\Monize" };
    expect(checkTargetPath(WIN.defaultDataDir, moved)).toBeNull();
    expect(checkTargetPath(`${WIN.defaultDataDir}\\new`, moved)).toBe(
      "inside-default",
    );
  });

  it("refuses what pg_ctl cannot quote on POSIX", () => {
    const rules: TargetRules = {
      platform: "linux",
      source: "/home/a/.local/share/Monize",
      defaultDataDir: "/home/a/.local/share/Monize",
      installDir: null,
    };
    expect(checkTargetPath("/mnt/big/Monize", rules)).toBeNull();
    expect(checkTargetPath("/mnt/$big/Monize", rules)).toBe("unstorable");
    expect(checkTargetPath("/", rules)).toBe("root");
  });
});

describe("inspectTarget", () => {
  let fixture: MoveFixture;
  let rules: TargetRules;
  beforeEach(() => {
    fixture = createMoveFixture();
    rules = {
      platform: process.platform,
      source: fixture.source,
      defaultDataDir: fixture.source,
      installDir: null,
    };
  });
  afterEach(() => fixture.cleanup());

  const inspect = (target: string, bytes = 1000) =>
    inspectTarget(nodeMoveFs, target, bytes, rules);

  it("accepts a new folder whose parent exists, and an existing empty one", async () => {
    expect((await inspect(fixture.target)).problem).toBeNull();
    mkdirSync(fixture.target);
    const verdict = await inspect(`${fixture.target}/`);
    expect(verdict).toMatchObject({ problem: null, target: fixture.target });
    expect(verdict.freeBytes).toBeGreaterThan(0);
  });

  it("refuses a folder with anything in it", async () => {
    mkdirSync(fixture.target);
    writeFileSync(join(fixture.target, "notes.txt"), "mine");
    expect((await inspect(fixture.target)).problem).toBe("not-empty");
  });

  it("refuses a file, a missing parent and a leftover staging folder", async () => {
    const file = join(fixture.root, "a-file");
    writeFileSync(file, "");
    expect((await inspect(file)).problem).toBe("not-a-folder");
    expect((await inspect(join(fixture.root, "no", "such"))).problem).toBe(
      "parent-missing",
    );
    mkdirSync(stagingFor(fixture.target));
    expect((await inspect(fixture.target)).problem).toBe("leftover");
  });

  it("refuses a new folder reached through another name for the data folder", async () => {
    const alias = join(fixture.root, "alias");
    symlinkSync(fixture.source, alias);
    expect((await inspect(join(alias, "new"))).problem).toBe("inside-data");
  });

  it("refuses when the volume has no room, and says how much is needed", async () => {
    const verdict = await inspectTarget(
      { ...nodeMoveFs, freeBytes: async () => 1000 },
      fixture.target,
      5000,
      rules,
    );
    expect(verdict).toMatchObject({
      problem: "no-space",
      freeBytes: 1000,
      neededBytes: neededBytesFor(5000),
    });
  });

  it("goes ahead when free space cannot be read", async () => {
    const verdict = await inspectTarget(
      { ...nodeMoveFs, freeBytes: async () => null },
      fixture.target,
      5000,
      rules,
    );
    expect(verdict.problem).toBeNull();
  });
});
