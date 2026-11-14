import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { readFileTail, readSourceTail } from "./log-tail";

describe("log tail", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monize-log-tail-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, text: string) =>
    writeFileSync(join(dir, name), text);
  const record = (msg: string) =>
    JSON.stringify({
      time: "2026-11-13T09:00:00.000Z",
      level: "info",
      source: "main",
      msg,
    });

  describe("readFileTail", () => {
    it("returns the last lines, oldest first", async () => {
      write("a.log", "1\n2\n3\n4\n5\n");
      expect(await readFileTail(join(dir, "a.log"), 3)).toEqual([
        "3",
        "4",
        "5",
      ]);
    });

    it("returns every line of a short file", async () => {
      write("a.log", "1\n2\n");
      expect(await readFileTail(join(dir, "a.log"), 10)).toEqual(["1", "2"]);
    });

    it("returns an empty list for an empty file", async () => {
      write("a.log", "");
      expect(await readFileTail(join(dir, "a.log"), 10)).toEqual([]);
    });

    it("returns null for a missing file", async () => {
      expect(await readFileTail(join(dir, "nope.log"), 10)).toBeNull();
    });

    it("keeps a last line that has no newline yet", async () => {
      write("a.log", "1\n2\nhalf a li");
      expect(await readFileTail(join(dir, "a.log"), 5)).toEqual([
        "1",
        "2",
        "half a li",
      ]);
    });

    it("strips carriage returns and skips blank lines", async () => {
      write("a.log", "1\r\n\r\n2\r\n");
      expect(await readFileTail(join(dir, "a.log"), 5)).toEqual(["1", "2"]);
    });

    it("reads only the end of a file bigger than the byte limit", async () => {
      const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}`);
      write("big.log", `${lines.join("\n")}\n`);
      const tail = await readFileTail(join(dir, "big.log"), 3, 64);
      expect(tail).toEqual(["line-4997", "line-4998", "line-4999"]);
    });

    it("drops the cut first line of a byte-limited window", async () => {
      write("big.log", `${"x".repeat(100)}\nab\ncd\n`);
      const tail = await readFileTail(join(dir, "big.log"), 10, 12);
      expect(tail).toEqual(["ab", "cd"]);
    });

    it("keeps a single cut line rather than return nothing", async () => {
      write("long.log", "y".repeat(200));
      const tail = await readFileTail(join(dir, "long.log"), 10, 50);
      expect(tail).toEqual(["y".repeat(50)]);
    });

    it("reads across chunk boundaries and multibyte text", async () => {
      const lines = Array.from(
        { length: 4000 },
        (_, i) => `é${i}-${"z".repeat(30)}`,
      );
      write("m.log", `${lines.join("\n")}\n`);
      const tail = await readFileTail(join(dir, "m.log"), 2000);
      expect(tail).toHaveLength(2000);
      expect(tail?.[0]).toBe(lines[2000]);
      expect(tail?.at(-1)).toBe(lines[3999]);
    });
  });

  describe("readSourceTail", () => {
    it("formats the JSON records of a source", async () => {
      write("main.log", `${record("one")}\n${record("two")}\n`);
      const tail = await readSourceTail(dir, "main", 10);
      expect(tail.found).toBe(true);
      expect(tail.lines).toEqual([
        "2026-11-13T09:00:00.000Z [main] INFO: one",
        "2026-11-13T09:00:00.000Z [main] INFO: two",
      ]);
    });

    it("continues into the rotated files when the live one is short", async () => {
      write("backend.log.2", "old-1\nold-2\n");
      write("backend.log.1", "mid-1\nmid-2\n");
      write("backend.log", "new-1\n");
      expect((await readSourceTail(dir, "backend", 4)).lines).toEqual([
        "old-2",
        "mid-1",
        "mid-2",
        "new-1",
      ]);
    });

    it("does not read further files once it has enough lines", async () => {
      write("backend.log.1", "mid-1\nmid-2\n");
      write("backend.log", "new-1\nnew-2\n");
      expect((await readSourceTail(dir, "backend", 3)).lines).toEqual([
        "mid-2",
        "new-1",
        "new-2",
      ]);
    });

    it("uses a rotated file when the live one is not there yet", async () => {
      write("frontend.log.1", "kept\n");
      expect(await readSourceTail(dir, "frontend", 5)).toEqual({
        found: true,
        lines: ["kept"],
      });
    });

    it("reports a source with no file as not found", async () => {
      expect(await readSourceTail(dir, "postgres", 5)).toEqual({
        found: false,
        lines: [],
      });
    });

    it("reads PostgreSQL's own log as plain text", async () => {
      write("postgres-server.log", "LOG:  database system is ready\n");
      expect((await readSourceTail(dir, "postgres-server", 5)).lines).toEqual([
        "LOG:  database system is ready",
      ]);
    });
  });
});
