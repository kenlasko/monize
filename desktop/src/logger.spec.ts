import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  createLogger,
  Logger,
  LoggerOptions,
  LogRecord,
  MAX_LINE_CHARS,
} from "./logger";
import { generateSecret } from "./secrets";

const FIXED = new Date("2026-11-13T10:00:00.000Z");

describe("logger", () => {
  let dir: string;
  let out: string[];
  let logger: Logger;

  function make(options: Partial<LoggerOptions> = {}): Logger {
    logger = createLogger({
      logsDir: join(dir, "logs"),
      stdout: { write: (text: string) => out.push(text) },
      now: () => FIXED,
      ...options,
    });
    return logger;
  }

  function fileRecords(name: string): LogRecord[] {
    return readFileSync(join(dir, "logs", name), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as LogRecord);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "monize-logger-"));
    out = [];
  });

  afterEach(() => {
    logger?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes one JSON line per record to the source's own file", () => {
    make();
    logger.info("starting");
    logger.log("backend", "error", "boom");
    expect(fileRecords("main.log")).toEqual([
      {
        time: FIXED.toISOString(),
        level: "info",
        source: "main",
        msg: "starting",
      },
    ]);
    expect(fileRecords("backend.log")[0]).toMatchObject({
      level: "error",
      msg: "boom",
    });
  });

  it("writes the server-log-format shape to stdout", () => {
    make();
    logger.warn("careful");
    expect(out).toEqual([`${FIXED.toISOString()} [main] WARN: careful\n`]);
  });

  it("stays silent on stdout when told to", () => {
    make({ stdout: null });
    logger.info("quiet");
    expect(out).toEqual([]);
  });

  it("keeps the last lines per source in a bounded ring", () => {
    make({ ringSize: 3 });
    for (let i = 0; i < 5; i++) logger.log("postgres", "info", `line ${i}`);
    logger.info("other source");
    expect(logger.tail("postgres", 50).map((r) => r.msg)).toEqual([
      "line 2",
      "line 3",
      "line 4",
    ]);
    expect(logger.tail("postgres", 1).map((r) => r.msg)).toEqual(["line 4"]);
    expect(logger.tail("postgres", 0)).toEqual([]);
    expect(logger.tail("frontend", 5)).toEqual([]);
  });

  it("rotates by size and keeps a fixed number of files", () => {
    make({ maxBytes: 200, maxFiles: 3, stdout: null });
    for (let i = 0; i < 40; i++)
      logger.log("backend", "info", `message number ${i}`);
    const names = readdirSync(join(dir, "logs")).sort();
    expect(names).toEqual(["backend.log", "backend.log.1", "backend.log.2"]);
    for (const name of names) {
      expect(readFileSync(join(dir, "logs", name)).length).toBeLessThanOrEqual(
        200,
      );
    }
    const newest = fileRecords("backend.log");
    expect(newest[newest.length - 1].msg).toBe("message number 39");
  });

  it("appends to an existing file and counts its size", () => {
    const logs = join(dir, "logs");
    make({ maxBytes: 150, stdout: null });
    logger.info("first");
    logger.close();
    writeFileSync(join(logs, "main.log"), "x".repeat(140) + "\n", {
      flag: "a",
    });
    make({ maxBytes: 150, stdout: null });
    logger.info("second");
    expect(readdirSync(logs).sort()).toEqual(["main.log", "main.log.1"]);
  });

  describe("lineSink", () => {
    it("splits chunks on newlines and holds a partial trailing line", () => {
      make();
      const sink = logger.lineSink("frontend", "info");
      sink.write("alpha\nbe");
      expect(logger.tail("frontend", 10).map((r) => r.msg)).toEqual(["alpha"]);
      sink.write(Buffer.from("ta\r\ngamma"));
      expect(logger.tail("frontend", 10).map((r) => r.msg)).toEqual([
        "alpha",
        "beta",
      ]);
      sink.end();
      expect(logger.tail("frontend", 10).map((r) => r.msg)).toEqual([
        "alpha",
        "beta",
        "gamma",
      ]);
    });

    it("reassembles a multi-byte character split across chunks", () => {
      make();
      const sink = logger.lineSink("backend", "warn");
      const bytes = Buffer.from("café\n");
      sink.write(bytes.subarray(0, 4));
      sink.write(bytes.subarray(4));
      expect(logger.tail("backend", 1)[0]).toMatchObject({
        msg: "café",
        level: "warn",
      });
    });

    it("cuts an endless line so memory stays bounded", () => {
      make({ stdout: null });
      const sink = logger.lineSink("backend", "info");
      sink.write("y".repeat(MAX_LINE_CHARS + 10));
      expect(logger.tail("backend", 5).map((r) => r.msg.length)).toEqual([
        MAX_LINE_CHARS,
      ]);
      sink.end();
      expect(logger.tail("backend", 5).map((r) => r.msg.length)).toEqual([
        MAX_LINE_CHARS,
        10,
      ]);
    });
  });

  it("never writes a registered secret anywhere", () => {
    make();
    const secret = generateSecret();
    logger.redact(secret);
    logger.error(
      `connect failed for postgres://monize:${secret}@127.0.0.1:5433`,
    );
    logger.lineSink("backend", "info").write(`JWT_SECRET=${secret}\n`);
    const everything = [
      readFileSync(join(dir, "logs", "main.log"), "utf8"),
      readFileSync(join(dir, "logs", "backend.log"), "utf8"),
      out.join(""),
      JSON.stringify(logger.tail("main", 10)),
      JSON.stringify(logger.tail("backend", 10)),
    ].join("\n");
    expect(everything).not.toContain(secret);
    expect(everything).toContain("[redacted]");
  });

  it("keeps working when the log folder cannot be written", () => {
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "file");
    make({ logsDir: blocked });
    logger.info("still here");
    logger.info("and here");
    expect(logger.tail("main", 5).map((r) => r.msg)).toEqual([
      "still here",
      "and here",
    ]);
    expect(
      out.filter((line) => line.includes("cannot write main.log")),
    ).toHaveLength(1);
  });
});
