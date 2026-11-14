import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { answerTail, viewerSetup } from "./log-viewer-service";

describe("log viewer service", () => {
  let root: string;
  let logs: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "monize-viewer-"));
    logs = join(root, "logs");
    mkdirSync(logs);
    writeFileSync(join(root, "config.json"), "SECRET-CONFIG\n");
    writeFileSync(join(logs, "main.log"), "a\nb\nc\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("answers a listed source", async () => {
    expect(await answerTail(logs, "main", 2)).toEqual({
      ok: true,
      found: true,
      lines: ["b", "c"],
    });
  });

  it("answers a listed source with no file as not found", async () => {
    expect(await answerTail(logs, "frontend", 2)).toEqual({
      ok: true,
      found: false,
      lines: [],
    });
  });

  it("refuses a name that is not in the allowlist, a path included", async () => {
    for (const source of [
      "../config.json",
      "..\\config.json",
      join(root, "config.json"),
      "main.log",
      undefined,
      7,
    ]) {
      expect(await answerTail(logs, source, 10)).toEqual({ ok: false });
    }
  });

  it("clamps a hostile line count instead of trusting it", async () => {
    expect(await answerTail(logs, "main", 10 ** 12)).toMatchObject({
      ok: true,
      lines: ["a", "b", "c"],
    });
    expect(await answerTail(logs, "main", "all")).toMatchObject({ ok: true });
  });

  it("describes every source and the page's words", () => {
    const setup = viewerSetup();
    expect(setup.sources.map((source) => source.id)).toEqual([
      "main",
      "backend",
      "frontend",
      "postgres",
      "postgres-server",
    ]);
    for (const text of Object.values(setup.text)) {
      expect(text.length).toBeGreaterThan(0);
    }
  });
});
