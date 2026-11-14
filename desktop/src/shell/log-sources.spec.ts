import { LOG_SOURCES } from "../logger";
import {
  displayLine,
  parseViewerLines,
  parseViewerSource,
  VIEWER_DEFAULT_LINES,
  VIEWER_MAX_LINE_CHARS,
  VIEWER_MAX_LINES,
  VIEWER_SOURCE_FILES,
  VIEWER_SOURCE_IDS,
  viewerSources,
} from "./log-sources";

describe("viewer sources", () => {
  it("covers every logger source and PostgreSQL's server log", () => {
    expect([...VIEWER_SOURCE_IDS].sort()).toEqual(
      [...LOG_SOURCES, "postgres-server"].sort(),
    );
  });

  it("maps every id to a plain file name with no directory part", () => {
    for (const file of Object.values(VIEWER_SOURCE_FILES)) {
      expect(file).toMatch(/^[a-z-]+\.log$/);
    }
  });

  it("labels every source", () => {
    expect(viewerSources().map((source) => source.id)).toEqual([
      ...VIEWER_SOURCE_IDS,
    ]);
    for (const source of viewerSources()) {
      expect(source.label.length).toBeGreaterThan(0);
    }
  });
});

describe("parseViewerSource", () => {
  it("accepts the listed ids", () => {
    for (const id of VIEWER_SOURCE_IDS) expect(parseViewerSource(id)).toBe(id);
  });

  it("refuses anything else, paths included", () => {
    for (const value of [
      "../config.json",
      "main.log",
      "..\\main",
      "/etc/passwd",
      "MAIN",
      "",
      "__proto__",
      "constructor",
      null,
      undefined,
      42,
      {},
    ]) {
      expect(parseViewerSource(value)).toBeNull();
    }
  });
});

describe("parseViewerLines", () => {
  it("passes a sensible count through and clamps the rest", () => {
    expect(parseViewerLines(300)).toBe(300);
    expect(parseViewerLines(0)).toBe(1);
    expect(parseViewerLines(-5)).toBe(1);
    expect(parseViewerLines(10 ** 9)).toBe(VIEWER_MAX_LINES);
    expect(parseViewerLines(12.9)).toBe(12);
  });

  it("falls back to the default for a non-number", () => {
    for (const value of ["5", null, undefined, NaN, Infinity, {}]) {
      expect(parseViewerLines(value)).toBe(VIEWER_DEFAULT_LINES);
    }
  });
});

describe("displayLine", () => {
  it("renders a log record in the console shape", () => {
    const raw = JSON.stringify({
      time: "2026-11-13T09:00:00.000Z",
      level: "warn",
      source: "backend",
      msg: "slow query",
    });
    expect(displayLine(raw)).toBe(
      "2026-11-13T09:00:00.000Z [backend] WARN: slow query",
    );
  });

  it("leaves other text, and JSON of another shape, as it is", () => {
    expect(displayLine("LOG:  ready")).toBe("LOG:  ready");
    expect(displayLine('{"a":1}')).toBe('{"a":1}');
    expect(displayLine("123")).toBe("123");
  });

  it("clips a very long line", () => {
    const shown = displayLine("x".repeat(VIEWER_MAX_LINE_CHARS + 50));
    expect(shown).toHaveLength(VIEWER_MAX_LINE_CHARS + 3);
    expect(shown.endsWith("...")).toBe(true);
  });
});
