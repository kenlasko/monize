import { flush, manualClock } from "../test-support/manual-clock";
import {
  QUIT_POLL_MS,
  QUIT_TIMED_OUT_EXIT_CODE,
  QUIT_WAIT_MS,
  quitExitCode,
  waitForOtherShellToExit,
} from "./quit-wait";

describe("waitForOtherShellToExit", () => {
  it("resolves true as soon as the lock can be taken", async () => {
    const clock = manualClock();
    let attempts = 0;
    const done = waitForOtherShellToExit({
      clock,
      tryLock: () => {
        attempts += 1;
        return attempts === 3;
      },
    });
    let result: boolean | undefined;
    void done.then((value) => (result = value));

    await clock.advance(QUIT_POLL_MS * 2);
    expect(attempts).toBe(2);
    expect(result).toBeUndefined();

    await clock.advance(QUIT_POLL_MS);
    await flush();
    expect(result).toBe(true);
    expect(attempts).toBe(3);
    expect(clock.pending).toBe(0);
  });

  it("does not ask before the first pause, so the running shell can begin its stop", async () => {
    const clock = manualClock();
    let attempts = 0;
    void waitForOtherShellToExit({
      clock,
      tryLock: () => {
        attempts += 1;
        return false;
      },
    });
    await flush();
    expect(attempts).toBe(0);
  });

  it("gives up after the bound and says so", async () => {
    const clock = manualClock();
    let attempts = 0;
    const done = waitForOtherShellToExit({
      clock,
      tryLock: () => {
        attempts += 1;
        return false;
      },
    });
    await clock.advance(QUIT_WAIT_MS);
    await expect(done).resolves.toBe(false);
    expect(attempts).toBe(QUIT_WAIT_MS / QUIT_POLL_MS);
    expect(clock.pending).toBe(0);
  });
});

describe("quitExitCode", () => {
  it("is zero only when the other shell has gone", () => {
    expect(quitExitCode(true)).toBe(0);
    expect(quitExitCode(false)).toBe(QUIT_TIMED_OUT_EXIT_CODE);
    expect(QUIT_TIMED_OUT_EXIT_CODE).not.toBe(0);
  });
});
