import { systemClock } from "./clock";

describe("systemClock", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("resolves a sleep when its time has passed", async () => {
    jest.useFakeTimers();
    let woke = false;
    const sleeping = systemClock.sleep(500).then(() => {
      woke = true;
    });

    await jest.advanceTimersByTimeAsync(499);
    expect(woke).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await sleeping;
    expect(woke).toBe(true);
  });

  it("resolves early when the signal aborts, and clears its timer", async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    const sleeping = systemClock.sleep(60_000, controller.signal);
    expect(jest.getTimerCount()).toBe(1);

    controller.abort();

    await sleeping;
    expect(jest.getTimerCount()).toBe(0);
  });

  it("arms no timer for a signal that is already aborted", async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    controller.abort();

    await systemClock.sleep(60_000, controller.signal);

    expect(jest.getTimerCount()).toBe(0);
  });

  it("waits for the signal alone when the delay is not finite", async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    let woke = false;
    const sleeping = systemClock
      .sleep(Number.POSITIVE_INFINITY, controller.signal)
      .then(() => {
        woke = true;
      });

    // Passed to setTimeout, Infinity would fire after one millisecond.
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(woke).toBe(false);

    controller.abort();
    await sleeping;
    expect(woke).toBe(true);
  });

  it("unrefs its timer, so a pending deadline does not keep the process alive", async () => {
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");
    const controller = new AbortController();

    const sleeping = systemClock.sleep(60_000, controller.signal);

    const timer = setTimeoutSpy.mock.results[0].value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    controller.abort();
    await sleeping;
  });

  it("reads a clock that does not go backwards", () => {
    const first = systemClock.now();
    expect(systemClock.now()).toBeGreaterThanOrEqual(first);
  });
});
