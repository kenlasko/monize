import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  DataLocation,
  isStorablePath,
  LocationError,
  locationFileFor,
  parseLocation,
  readLocationSync,
  serializeLocation,
  writeLocation,
} from "./location";

const WINDOWS: DataLocation = {
  dataDir: "D:\\Données\\Monize",
  previousDataDir: "C:\\Users\\Zoë B\\AppData\\Local\\Monize",
  state: "pending",
  movedAt: "2026-11-13T10:00:00.000Z",
};

function ini(lines: readonly string[]): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(lines.join("\r\n"), "utf16le"),
  ]);
}

describe("the pointer file", () => {
  it("sits beside the default data folder, not in it", () => {
    expect(locationFileFor("C:\\Users\\a\\AppData\\Local\\Monize")).toBe(
      "C:\\Users\\a\\AppData\\Local\\Monize-location.ini",
    );
  });

  it("is an INI file in UTF-16LE with a byte-order mark, as the installer reads it", () => {
    const data = serializeLocation(WINDOWS);
    expect([data[0], data[1]]).toEqual([0xff, 0xfe]);
    expect(data.subarray(2).toString("utf16le")).toBe(
      "[location]\r\nversion=1\r\ndataDir=D:\\Données\\Monize\r\n" +
        "previousDataDir=C:\\Users\\Zoë B\\AppData\\Local\\Monize\r\n" +
        "state=pending\r\nmovedAt=2026-11-13T10:00:00.000Z\r\n",
    );
  });

  it("round-trips, with and without a previous folder", () => {
    for (const location of [WINDOWS, { ...WINDOWS, previousDataDir: null }]) {
      expect(parseLocation(serializeLocation(location), "f", "win32")).toEqual(
        location,
      );
    }
  });

  it.each([
    ["no byte-order mark", Buffer.from("[location]\r\n", "utf8")],
    ["another section", ini(["[other]", "version=1"])],
    ["an unknown key", ini(["[location]", "version=1", "extra=1"])],
    [
      "a missing key",
      ini(["[location]", "version=1", "dataDir=D:\\M", "state=pending"]),
    ],
    ["a key twice", ini(["[location]", "version=1", "version=1"])],
  ])("refuses %s", (_name, data) => {
    expect(() => parseLocation(data, "f", "win32")).toThrow(LocationError);
  });

  it.each([
    ["version", "2"],
    ["dataDir", "Monize"],
    ["dataDir", ""],
    ["previousDataDir", "relative\\path"],
    ["state", "done"],
    ["movedAt", "yesterday"],
  ])("refuses %s=%s rather than guessing", (key, value) => {
    const values: Record<string, string> = {
      version: "1",
      dataDir: "D:\\Monize",
      previousDataDir: "",
      state: "confirmed",
      movedAt: "2026-11-13T10:00:00.000Z",
      [key]: value,
    };
    const data = ini([
      "[location]",
      ...Object.entries(values).map(([k, v]) => `${k}=${v}`),
      "",
    ]);
    expect(() => parseLocation(data, "f", "win32")).toThrow(LocationError);
  });

  it("knows which paths the INI format would change", () => {
    expect(isStorablePath("D:\\Monize data")).toBe(true);
    expect(isStorablePath(" D:\\Monize")).toBe(false);
    expect(isStorablePath("/data/monize ")).toBe(false);
    expect(isStorablePath('"/data/monize"')).toBe(false);
    expect(isStorablePath("/data/mon\nize")).toBe(false);
    expect(isStorablePath("")).toBe(false);
  });

  describe("on disk", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "monize-location-"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const posixLocation: DataLocation = {
      dataDir: "/mnt/big/Monize",
      previousDataDir: null,
      state: "confirmed",
      movedAt: "2026-11-13T10:00:00.000Z",
    };

    it("reads null when there is no pointer", () => {
      expect(readLocationSync(join(dir, "none.ini"), "linux")).toBeNull();
    });

    it("writes and reads back", async () => {
      const file = join(dir, "Monize-location.ini");
      await writeLocation(file, posixLocation);
      expect(readLocationSync(file, "linux")).toEqual(posixLocation);
    });

    it("stops on a damaged pointer, naming the file", () => {
      const file = join(dir, "Monize-location.ini");
      writeFileSync(file, "garbage");
      expect(() => readLocationSync(file, "linux")).toThrow(file);
    });

    it("stops on a pointer it cannot read", () => {
      // A directory in the file's place: readable as a name, not as a file.
      expect(() => readLocationSync(dir, "linux")).toThrow(LocationError);
    });

    it("refuses to record a path the format would change", async () => {
      const write = jest.fn();
      await expect(
        writeLocation("f", { ...posixLocation, dataDir: "/data/x " }, write),
      ).rejects.toThrow();
      expect(write).not.toHaveBeenCalled();
    });
  });
});
