import { ChildProcess, spawn, StdioOptions } from "child_process";
import { join } from "path";

/**
 * Real processes for the parent-watch specs, for specs only. Everything here
 * runs `process.execPath` (Node under jest), so it behaves the same on Linux
 * and Windows; the only platform-specific act is the spec's own `SIGKILL`,
 * which Node turns into `TerminateProcess` on Windows.
 */

/** The preload as it is in the repository, before staging. */
export const REPO_PARENT_WATCH = join(
  __dirname,
  "..",
  "..",
  "resources",
  "parent-watch.cjs",
);

/** Rejects with `what` unless `promise` settles within `ms`; no timer survives. */
export function within<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} did not happen within ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** A process whose stdout is read line by line and whose exit is awaited. */
export interface Watched {
  readonly process: ChildProcess;
  readonly lines: string[];
  /** Resolves once a line matching `test` has been printed. */
  line(test: RegExp): Promise<RegExpMatchArray>;
  /** Resolves once `count` lines matching `test` have been printed. */
  count(test: RegExp, count: number): Promise<void>;
  /** Resolves when the stdout pipe reaches end-of-file: every writer is gone. */
  readonly stdoutClosed: Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
}

function watch(child: ChildProcess): Watched {
  const lines: string[] = [];
  const waiters: (() => void)[] = [];
  let partial = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop() ?? "";
    lines.push(...parts.map((part) => part.trimEnd()));
    for (const waiter of [...waiters]) waiter();
  });
  const until = (done: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (!done()) return;
        waiters.splice(waiters.indexOf(check), 1);
        resolve();
      };
      waiters.push(check);
      check();
    });
  return {
    process: child,
    lines,
    async line(test) {
      await until(() => lines.some((line) => test.test(line)));
      return lines
        .find((line) => test.test(line))
        ?.match(test) as RegExpMatchArray;
    },
    count: (test, count) =>
      until(() => lines.filter((line) => test.test(line)).length >= count),
    stdoutClosed: new Promise((resolve) => child.stdout?.once("end", resolve)),
    exited: new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    ),
  };
}

const started: ChildProcess[] = [];
const orphans = new Set<number>();

/** `node --require <preload> -e <script>`, with the given stdin. */
export function runGuarded(
  script: string,
  stdin: "pipe" | "ignore",
  preload = REPO_PARENT_WATCH,
): Watched {
  const stdio: StdioOptions = [stdin, "pipe", "ignore"];
  const child = spawn(process.execPath, ["--require", preload, "-e", script], {
    stdio,
    windowsHide: true,
  });
  started.push(child);
  return watch(child);
}

/**
 * A stand-in for the shell: a Node process that starts `script` under the
 * preload exactly as the supervisor does (stdin a pipe it never writes to),
 * hands the grandchild its own stdout, prints `grandchild <pid>`, and stays
 * alive as long as the grandchild does. Because the grandchild shares that
 * stdout, `stdoutClosed` resolves only once the grandchild is gone too.
 * `closeStdin` makes the stand-in end the pipe itself after starting it.
 */
export function startShell(
  script: string,
  options: { readonly closeStdin?: boolean } = {},
): Watched {
  const shell = [
    'const { spawn } = require("child_process");',
    "const [preload, script, closeStdin] = process.argv.slice(1);",
    "const child = spawn(process.execPath, ['--require', preload, '-e', script],",
    "  { stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });",
    "child.stdin.on('error', () => undefined);",
    "process.stdout.write('grandchild ' + child.pid + '\\n');",
    "if (closeStdin === 'yes') child.stdin.end();",
  ].join("\n");
  const child = spawn(
    process.execPath,
    ["-e", shell, REPO_PARENT_WATCH, script, options.closeStdin ? "yes" : "no"],
    { stdio: ["ignore", "pipe", "inherit"], windowsHide: true },
  );
  started.push(child);
  const watched = watch(child);
  void watched.line(/^grandchild (\d+)$/).then((match) => {
    const pid = Number(match[1]);
    orphans.add(pid);
    void watched.stdoutClosed.then(() => orphans.delete(pid));
  });
  return watched;
}

/**
 * For `afterEach`: kill whatever a failed spec left running. A grandchild is
 * only signalled while the pipe it shares with the spec is still open, which
 * means it is still the process the spec started.
 */
export function killLeftovers(): void {
  for (const child of started.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  }
  for (const pid of orphans) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  orphans.clear();
}
