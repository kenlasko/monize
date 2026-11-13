import { posix, win32 } from "path";
import { PostgresTimeouts } from "./postgres-types";

/**
 * The argument lists handed to `initdb` and `pg_ctl`, kept apart from the
 * sequencing so each can be read and tested as data.
 *
 * Every list is an argv array given to the binary directly, never a shell
 * string, so a data directory such as
 * `C:\Users\First Last\AppData\Local\Monize\pgdata` needs no quoting here.
 * `pg_ctl start` is the exception one level down: it builds its own command
 * line for `/bin/sh -c` (CMD.EXE /C on Windows) and pastes the `-o` text into
 * it unquoted, while wrapping the `-D` and `-l` paths in double quotes itself.
 * So the `-o` text below carries no path and no character either shell reads
 * (`settingsOption` refuses anything else), and `shellUnsafeIn` names the path
 * characters that survive pg_ctl's double quotes.
 */

export const DEFAULT_TIMEOUTS: PostgresTimeouts = {
  // A first initdb on a slow disk behind a virus scanner writes about a
  // thousand files and syncs each one.
  initSeconds: 300,
  // Covers crash recovery; pg_ctl leaves a server that is still recovering
  // running when this passes, and the runner then stops it.
  startSeconds: 120,
  readySeconds: 30,
  stopFastSeconds: 30,
  stopImmediateSeconds: 15,
};

/** The `path` flavour of the platform the binaries run on. */
export type PathModule = typeof posix;

export function pathFor(platform: NodeJS.Platform): PathModule {
  return platform === "win32" ? win32 : posix;
}

export function binaryPath(
  binDir: string,
  name: "initdb" | "pg_ctl",
  platform: NodeJS.Platform,
): string {
  const suffix = platform === "win32" ? ".exe" : "";
  return pathFor(platform).join(binDir, `${name}${suffix}`);
}

/**
 * The password reaches initdb through `--pwfile`, never through an argument:
 * an argument list is readable by every process of the same user.
 */
export function initdbArgs(input: {
  readonly dataDir: string;
  readonly superuser: string;
  readonly pwFile: string;
}): readonly string[] {
  return [
    `--pgdata=${input.dataDir}`,
    `--username=${input.superuser}`,
    `--pwfile=${input.pwFile}`,
    "--auth=scram-sha-256",
    "--encoding=UTF8",
    "--locale=C",
  ];
}

/**
 * Server settings fixed on the command line, where they outrank
 * `postgresql.conf` and `ALTER SYSTEM`, so the settings in force are the ones
 * this shell passed on this start.
 *
 * - `listen_addresses`, `port`: loopback only, on the persisted port.
 * - `unix_socket_directories` empty: connections are TCP only. The default on
 *   Linux drops a world-visible socket in `/tmp`; Windows already defaults to
 *   none. pg_ctl's own wait reads `postmaster.pid`, it does not connect.
 * - `timezone=UTC`: initdb writes the machine's zone into `postgresql.conf`.
 *   The containers run the server in UTC and the backend runs with `TZ=UTC`,
 *   so `CURRENT_TIMESTAMP` into a `TIMESTAMP` column must mean UTC here too.
 * - `log_timezone=UTC`: the server log lines up with the backend's.
 * - `log_checkpoints=off`: on by default since PostgreSQL 15, it appends a
 *   line every few minutes to a log file nothing rotates.
 *
 * Durability settings (`fsync`, `synchronous_commit`, `full_page_writes`) are
 * deliberately left at their defaults.
 */
export function serverSettings(port: number): readonly string[] {
  return [
    "listen_addresses=127.0.0.1",
    `port=${port}`,
    "unix_socket_directories=",
    "timezone=UTC",
    "log_timezone=UTC",
    "log_checkpoints=off",
  ];
}

const SHELL_INERT = /^[A-Za-z0-9_.,=-]+$/;

/** The `-o` text. Throws on a setting either shell would interpret. */
export function settingsOption(settings: readonly string[]): string {
  const unsafe = settings.find((setting) => !SHELL_INERT.test(setting));
  if (unsafe !== undefined) {
    throw new Error(`server setting is not shell-inert: ${unsafe}`);
  }
  return settings.map((setting) => `-c ${setting}`).join(" ");
}

/**
 * `-w` waits until `postmaster.pid` reports the server ready (or `-t` passes),
 * `-l` gives the server a file for its stdout and stderr: it must not inherit
 * a pipe from this process, or the pipe never closes and the wait never ends.
 */
export function startArgs(input: {
  readonly dataDir: string;
  readonly serverLogFile: string;
  readonly port: number;
  readonly timeoutSeconds: number;
}): readonly string[] {
  return [
    "start",
    "-D",
    input.dataDir,
    "-w",
    "-t",
    String(input.timeoutSeconds),
    "-l",
    input.serverLogFile,
    "-o",
    settingsOption(serverSettings(input.port)),
  ];
}

/**
 * `fast` rolls open transactions back, checkpoints and exits. `immediate`
 * skips the checkpoint, so the next start replays the write-ahead log; no
 * committed transaction is lost by either.
 */
export function stopArgs(input: {
  readonly dataDir: string;
  readonly mode: "fast" | "immediate";
  readonly timeoutSeconds: number;
}): readonly string[] {
  return [
    "stop",
    "-D",
    input.dataDir,
    "-m",
    input.mode,
    "-w",
    "-t",
    String(input.timeoutSeconds),
  ];
}

export function statusArgs(dataDir: string): readonly string[] {
  return ["status", "-D", dataDir];
}

/**
 * The characters of a path that pg_ctl's double quotes do not neutralise in
 * the command line it builds: `"` ends the quoting on both platforms, and
 * `/bin/sh` still expands `$`, a backquote and a backslash inside it. CMD.EXE
 * reads none of the characters a Windows path can contain, spaces and
 * parentheses included, except a `%NAME%` pair naming a real variable.
 */
export function shellUnsafeIn(
  path: string,
  platform: NodeJS.Platform,
): string | undefined {
  const unsafe = platform === "win32" ? /["\r\n]/ : /["$`\\\r\n]/;
  return unsafe.exec(path)?.[0];
}
