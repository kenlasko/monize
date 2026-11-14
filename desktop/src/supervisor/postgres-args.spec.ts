import {
  binaryPath,
  serverSettings,
  settingsOption,
  shellUnsafeIn,
  startArgs,
} from "./postgres-args";
import { createRedactor, tailOf } from "./postgres-errors";

describe("binaryPath", () => {
  it("joins with the platform's separator and appends .exe on Windows only", () => {
    expect(binaryPath("/opt/pg/bin", "pg_ctl", "linux")).toBe(
      "/opt/pg/bin/pg_ctl",
    );
    expect(
      binaryPath("C:\\Program Files\\Monize\\postgres\\bin", "initdb", "win32"),
    ).toBe("C:\\Program Files\\Monize\\postgres\\bin\\initdb.exe");
  });
});

describe("serverSettings", () => {
  it("binds loopback only, on the given port, with no socket file", () => {
    const settings = serverSettings(5433);
    expect(settings).toContain("listen_addresses=127.0.0.1");
    expect(settings).toContain("port=5433");
    expect(settings).toContain("unix_socket_directories=");
  });

  it("leaves every durability setting at its default", () => {
    const names = serverSettings(5433).map((setting) => setting.split("=")[0]);
    for (const name of [
      "fsync",
      "synchronous_commit",
      "full_page_writes",
      "wal_level",
    ]) {
      expect(names).not.toContain(name);
    }
  });

  // pg_ctl pastes the -o text into a /bin/sh or CMD.EXE command line as is.
  it("holds nothing either shell would interpret", () => {
    expect(settingsOption(serverSettings(65535))).toMatch(
      /^(-c [A-Za-z0-9_.,=-]+ ?)+$/,
    );
  });
});

describe("settingsOption", () => {
  it.each([
    ["a space", "log_directory=C:\\Users\\First Last\\logs"],
    ["a quote", "search_path='public'"],
    ["a variable", "log_directory=$HOME"],
    ["a command separator", "port=5433;reboot"],
    ["a redirect", "port=5433>x"],
    ["a percent sign", "log_line_prefix=%m"],
  ])("refuses a setting containing %s", (_case, setting) => {
    expect(() => settingsOption([setting])).toThrow("not shell-inert");
  });
});

describe("startArgs", () => {
  it("passes the data directory and the log file as arguments of their own", () => {
    const args = startArgs({
      dataDir: "C:\\Users\\First Last\\AppData\\Local\\Monize\\pgdata",
      serverLogFile: "C:\\Users\\First Last\\AppData\\Local\\Monize\\pg.log",
      port: 5433,
      timeoutSeconds: 60,
    });
    expect(args[args.indexOf("-D") + 1]).toBe(
      "C:\\Users\\First Last\\AppData\\Local\\Monize\\pgdata",
    );
    expect(args[args.indexOf("-l") + 1]).toBe(
      "C:\\Users\\First Last\\AppData\\Local\\Monize\\pg.log",
    );
    expect(args[args.indexOf("-o") + 1]).not.toContain("First Last");
  });
});

describe("shellUnsafeIn", () => {
  it("accepts the paths a Windows profile produces", () => {
    for (const path of [
      "C:\\Users\\First Last\\AppData\\Local\\Monize\\pgdata",
      "C:\\Users\\O'Brien (Home)\\AppData\\Local\\Monize\\pgdata",
      "D:\\Data & Backups\\Monize\\pgdata",
    ]) {
      expect(shellUnsafeIn(path, "win32")).toBeUndefined();
    }
  });

  it("names the character pg_ctl's quoting does not survive", () => {
    expect(shellUnsafeIn('C:\\a"b', "win32")).toBe('"');
    expect(shellUnsafeIn("/home/a b/pgdata", "linux")).toBeUndefined();
    expect(shellUnsafeIn("/home/$USER/pgdata", "linux")).toBe("$");
    expect(shellUnsafeIn("/home/`id`/pgdata", "linux")).toBe("`");
    expect(shellUnsafeIn("/home/a\\b", "linux")).toBe("\\");
  });
});

describe("tailOf", () => {
  it("keeps the last lines and normalises Windows line endings", () => {
    const output = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join(
      "\r\n",
    );
    const tail = tailOf(`${output}\r\n`).split("\n");
    expect(tail).toHaveLength(25);
    expect(tail[0]).toBe("line 16");
    expect(tail.at(-1)).toBe("line 40");
  });

  it("bounds one enormous line", () => {
    expect(tailOf("x".repeat(10_000))).toHaveLength(4000);
  });
});

describe("createRedactor", () => {
  it("replaces every occurrence, treating the secret as plain text", () => {
    const redact = createRedactor("a.b+c$");
    expect(redact("a.b+c$ and a.b+c$ but not aXb+c$")).toBe(
      "[redacted] and [redacted] but not aXb+c$",
    );
  });

  it("leaves text alone when there is no secret", () => {
    expect(createRedactor("")("text")).toBe("text");
  });
});
