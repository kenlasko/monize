import { spawn } from "child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { binaryEnvironment, createOsDeps, osFs } from "./postgres-os";

/**
 * The real capabilities, exercised with `node` standing in for the PostgreSQL
 * binaries. The binaries themselves are covered by the smoke script.
 */

const NODE = process.execPath;
const deps = createOsDeps();
const onLinux = process.platform === "linux" ? it : it.skip;
const onPosix = process.platform === "win32" ? it.skip : it;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "monize desktop spec "));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("run", () => {
  it("captures stdout and stderr and the exit code", async () => {
    const result = await deps.run(
      NODE,
      ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
      { timeoutMs: 20_000 },
    );
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  it("passes an argument with spaces and quotes through unchanged", async () => {
    const awkward = 'C:\\Users\\First Last\\a "quoted" dir\\';
    const result = await deps.run(
      NODE,
      ["-e", "process.stdout.write(process.argv[1])", awkward],
      { timeoutMs: 20_000 },
    );
    expect(result.output).toBe(awkward);
  });

  it("kills a binary that outlasts its bound and says so", async () => {
    const result = await deps.run(NODE, ["-e", "setTimeout(() => {}, 60000)"], {
      timeoutMs: 300,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("reports a binary that is not there instead of throwing", async () => {
    const missing = join(dir, "pg_ctl");
    const result = await deps.run(missing, ["status"], { timeoutMs: 20_000 });
    expect(result.code).toBeNull();
    expect(result.output).toContain("ENOENT");
  });

  it("returns once the binary exits even if a process it left behind holds the pipe", async () => {
    const child = join(dir, "child.js");
    writeFileSync(child, "setTimeout(() => {}, 4000);");
    const started = Date.now();
    const result = await deps.run(
      NODE,
      [
        "-e",
        `require("child_process").spawn(process.execPath, [${JSON.stringify(child)}], { stdio: "inherit", detached: true }).unref(); console.log("parent done");`,
      ],
      { timeoutMs: 20_000 },
    );
    expect(result.code).toBe(0);
    expect(result.output).toContain("parent done");
    expect(Date.now() - started).toBeLessThan(3500);
  });
});

describe("runUnattended", () => {
  it("returns the exit code and no output", async () => {
    const result = await deps.runUnattended(
      NODE,
      ["-e", "console.log('ignored'); process.exit(2)"],
      { timeoutMs: 20_000 },
    );
    expect(result).toEqual({ code: 2, output: "", timedOut: false });
  });
});

describe("binaryEnvironment", () => {
  it("drops every PG variable, whatever its case, and keeps the rest", () => {
    const env = binaryEnvironment({
      PATH: "/usr/bin",
      SystemRoot: "C:\\Windows",
      PGDATA: "/elsewhere",
      PGPORT: "5432",
      PGPASSWORD: "leaked",
      pgoptions: "-c fsync=off",
    });
    expect(env).toEqual({
      PATH: "/usr/bin",
      SystemRoot: "C:\\Windows",
      LC_MESSAGES: "C",
    });
  });
});

describe("probeProcess", () => {
  const context = () => ({ dataDir: dir, pgCtl: join(dir, "pg_ctl") });

  onLinux("calls a pid nobody holds dead", async () => {
    const child = spawn(NODE, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid as number;
    await new Promise((resolve) => child.on("exit", resolve));
    expect(await deps.probeProcess(pid, context())).toBe("dead");
  });

  onLinux("calls a live process that is not a server other", async () => {
    expect(await deps.probeProcess(process.pid, context())).toBe("other");
  });

  onLinux(
    "calls a live process other even when it sits in the data directory",
    async () => {
      const child = spawn(NODE, ["-e", "setTimeout(() => {}, 20000)"], {
        cwd: dir,
        stdio: "ignore",
      });
      try {
        expect(await deps.probeProcess(child.pid as number, context())).toBe(
          "other",
        );
      } finally {
        child.kill();
      }
    },
  );
});

describe("osFs", () => {
  onPosix("creates the secret file with mode 0600", async () => {
    const file = join(dir, "pgdata.initdb-password");
    await osFs.writeSecret(file, "secret\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await osFs.readText(file)).toBe("secret\n");
  });

  it("refuses to write the secret over an existing file", async () => {
    const file = join(dir, "pgdata.initdb-password");
    writeFileSync(file, "planted");
    await expect(osFs.writeSecret(file, "secret\n")).rejects.toThrow("EEXIST");
  });

  it("removes a file, and resolves when there is none", async () => {
    const file = join(dir, "postmaster.pid");
    writeFileSync(file, "1\n");
    await osFs.remove(file);
    await osFs.remove(file);
    expect(await osFs.exists(file)).toBe(false);
  });

  it("writes a marker that list then shows", async () => {
    await osFs.makeDir(join(dir, "a", "pgdata"));
    await osFs.writeDurable(join(dir, "a", "pgdata", "marker"), "now\n");
    expect(await osFs.list(join(dir, "a", "pgdata"))).toEqual(["marker"]);
  });

  it("reads a log from an offset, and nothing from a missing one", async () => {
    const file = join(dir, "postgres.log");
    expect(await osFs.size(file)).toBe(0);
    expect(await osFs.readFrom(file, 0)).toBe("");
    writeFileSync(file, "old line\nnew line\n");
    expect(await osFs.size(file)).toBe(18);
    expect(await osFs.readFrom(file, 9)).toBe("new line\n");
    expect(await osFs.readFrom(file, 500)).toBe("");
  });
});
