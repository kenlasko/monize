import { EventEmitter } from "events";

import {
  ChildSpawnOptions,
  SpawnedProcess,
  SpawnFn,
} from "../supervisor/child";
import { BACKEND_DEPS_FILE } from "../supervisor/backend-deps";
import { PARENT_WATCH_FILE } from "../supervisor/parent-watch";

/** Where the specs say the preload is; `fileExists` is faked to match. */
export const FAKE_PARENT_WATCH = `/res/shell/${PARENT_WATCH_FILE}`;

/** The launcher's preload settings for a spec over the fake spawner. */
export const FAKE_PARENT_WATCH_DEPS = {
  parentWatch: FAKE_PARENT_WATCH,
  fileExists: (path: string) => path === FAKE_PARENT_WATCH,
} as const;

const DESKTOP_PRELOADS = [PARENT_WATCH_FILE, BACKEND_DEPS_FILE];

/**
 * A spawn's arguments without the leading desktop preloads (parent-watch, and
 * the backend's backend-deps), so a journal entry reads as the layer's own
 * command. Specs that are about the prefixes read `FakeProcess.args`, which
 * keeps them.
 */
export function layerArgs(args: readonly string[]): readonly string[] {
  let rest = args;
  while (
    rest[0] === "--require" &&
    DESKTOP_PRELOADS.some((file) => rest[1]?.endsWith(file))
  ) {
    rest = rest.slice(2);
  }
  return rest;
}

/**
 * A stand-in for a spawned process, for specs only. It does nothing until the
 * spec tells it to: print, exit, fail to start. By default it dies when it is
 * signalled, as a real process does; `ignore` makes it outlive a signal.
 */
export class FakeProcess extends EventEmitter implements SpawnedProcess {
  readonly stdin = new EventEmitter();
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly kills: NodeJS.Signals[] = [];
  pid: number | undefined;
  running = true;
  private ignored: readonly NodeJS.Signals[] = [];

  constructor(
    readonly command: string,
    readonly args: readonly string[],
    readonly options: ChildSpawnOptions,
    pid: number,
    private readonly journal: string[],
  ) {
    super();
    this.pid = pid;
  }

  /** The script this process runs: the last argument. */
  get script(): string {
    return this.args[this.args.length - 1];
  }

  ignore(...signals: NodeJS.Signals[]): this {
    this.ignored = signals;
    return this;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    if (!this.running) return false;
    this.kills.push(signal);
    this.journal.push(`kill ${this.script} ${signal}`);
    if (!this.ignored.includes(signal)) {
      queueMicrotask(() => this.exit(null, signal));
    }
    return true;
  }

  /** End the process: `exit`, then `close` once its output has drained. */
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (!this.exitOnly(code, signal)) return;
    this.emit("close", code, signal);
  }

  /** End the process but leave its pipes open, so `close` never comes. */
  exitOnly(code: number | null, signal: NodeJS.Signals | null = null): boolean {
    if (!this.running) return false;
    this.running = false;
    this.journal.push(`exit ${this.script}`);
    this.emit("exit", code, signal);
    return true;
  }

  /** The asynchronous spawn failure Node reports for a missing executable. */
  failToStart(code: string): void {
    this.pid = undefined;
    this.running = false;
    this.emit(
      "error",
      Object.assign(new Error(`spawn ${this.command} ${code}`), { code }),
    );
  }
}

export interface FakeSpawner {
  readonly spawn: SpawnFn;
  readonly processes: readonly FakeProcess[];
  /** Everything that happened, in order: `spawn <layer args>`, `kill <script> <signal>`, `exit <script>`. */
  readonly journal: string[];
  /** The most recent process running `script`. */
  find(script: string): FakeProcess;
  /** Called with each process as it is created, before the caller sees it. */
  onSpawn: (process: FakeProcess) => void;
}

export function fakeSpawner(journal: string[] = []): FakeSpawner {
  const processes: FakeProcess[] = [];
  const spawner: FakeSpawner = {
    processes,
    journal,
    onSpawn: () => undefined,
    spawn(command, args, options) {
      journal.push(`spawn ${layerArgs(args).join(" ")}`);
      const process = new FakeProcess(
        command,
        args,
        options,
        1000 + processes.length,
        journal,
      );
      processes.push(process);
      spawner.onSpawn(process);
      return process;
    },
    find(script) {
      const found = [...processes]
        .reverse()
        .find((process) => process.script === script);
      if (found === undefined) throw new Error(`no process runs ${script}`);
      return found;
    },
  };
  return spawner;
}
