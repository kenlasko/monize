import { AfterRestartUi } from "./after-restart";
import { MoveUi } from "./coordinator";
import { isMoveFault, MoveFault } from "./test-faults";

/**
 * The move with nobody at the dialogs, for exercising the real sequence end
 * to end from a command line. A development build started with
 * `--test-move-to=<folder>` runs the tray item's own function once the stack
 * is ready, with the folder picker answering that folder and the
 * confirmation answering yes; `--test-move-fault=<name>` adds a fault
 * (`test-faults.ts`); `--test-move-answers=rollback,delete` answers the
 * offers after the restart. Every dialog that would have been shown is
 * logged instead. `move-data.ts` ignores all three in a packaged build.
 */

export const TEST_FLAG_PREFIX = "--test-move-";

export interface UnattendedOptions {
  readonly target: string | null;
  readonly fault: MoveFault | null;
  readonly answers: readonly string[];
}

/** The options, or null when no `--test-move-*` flag was given. */
export function unattendedOptionsFrom(
  argv: readonly string[],
): UnattendedOptions | null {
  const value = (name: string): string | null => {
    const prefix = `${TEST_FLAG_PREFIX}${name}=`;
    const found = argv.find((arg) => arg.startsWith(prefix));
    return found === undefined ? null : found.slice(prefix.length);
  };
  if (!argv.some((arg) => arg.startsWith(TEST_FLAG_PREFIX))) return null;
  const fault = value("fault");
  return {
    target: value("to"),
    fault: fault !== null && isMoveFault(fault) ? fault : null,
    answers: (value("answers") ?? "").split(",").filter((item) => item !== ""),
  };
}

/**
 * The arguments a restart passes on. The move and its fault are not repeated
 * (the new shell would move again); the answers are, so the shell that comes
 * back is as unattended as the one that left.
 */
export function withoutTestFlags(argv: readonly string[]): string[] {
  return argv.filter(
    (arg) =>
      !arg.startsWith(`${TEST_FLAG_PREFIX}to=`) &&
      !arg.startsWith(`${TEST_FLAG_PREFIX}fault=`),
  );
}

export function unattendedUi(
  options: UnattendedOptions,
  log: (line: string) => void,
): MoveUi & AfterRestartUi {
  const say = (what: string): Promise<void> => {
    log(`move (unattended): ${what}`);
    return Promise.resolve();
  };
  const has = (answer: string): boolean => options.answers.includes(answer);
  let lastPhase = "";
  return {
    notMovable: (reason) => say(`not movable: ${reason}`),
    pickFolder: () => Promise.resolve(options.target),
    targetRefused: (verdict) =>
      say(`target refused: ${verdict.problem ?? ""} ${verdict.target}`),
    async confirm(plan) {
      await say(
        `confirmed moving ${plan.files} files, ${plan.bytes} bytes, from ${plan.source} to ${plan.target}`,
      );
      return true;
    },
    progress(progress) {
      if (progress.phase === lastPhase) return;
      lastPhase = progress.phase;
      log(`move (unattended): ${progress.phase}`);
    },
    moveFailed: (outcome, source) =>
      say(
        `move ${outcome.kind}: ${outcome.kind === "failed" ? `${outcome.failure}: ` : ""}${outcome.message}; still using ${source}; leftover: ${outcome.kind === "failed" ? outcome.leftover.join(", ") : "unknown"}`,
      ),
    interrupted: (result, current) =>
      say(
        `interrupted move to ${result.to} discarded; using ${current}; leftover: ${result.leftover.join(", ")}`,
      ),
    async offerRollback(current, previous) {
      await say(
        `offered going back from ${current} to ${previous}: ${has("rollback") ? "yes" : "no"}`,
      );
      return has("rollback");
    },
    rollbackRefused: (message) => say(`going back refused: ${message}`),
    async offerCleanup(current, old) {
      const choice = has("delete") ? "delete" : has("keep") ? "keep" : "later";
      await say(`offered deleting ${old} (current ${current}): ${choice}`);
      return choice;
    },
    cleanupResult: (result, old) =>
      say(`deleting ${old}: ${JSON.stringify(result)}`),
  };
}
