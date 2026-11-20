import { Logger } from "@nestjs/common";
import {
  WAKE_GAP_MS,
  WAKE_SETTLE_MS,
  WAKE_TICK_MS,
  WakeSettleService,
} from "./wake-settle.service";

describe("WakeSettleService", () => {
  let now: number;
  let service: WakeSettleService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    now = 1_700_000_000_000;
    service = new WakeSettleService(() => now);
  });

  afterEach(() => {
    service.onModuleDestroy();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("does not defer anything while the clock ticks normally", () => {
    for (let i = 0; i < 10; i++) {
      now += WAKE_TICK_MS;
      service.tick();
    }
    expect(service.settleDelayMs()).toBe(0);
  });

  it("defers for the settle window after a gap the size of a sleep", () => {
    service.tick();
    now += 8 * 60 * 60_000; // asleep overnight
    service.tick();
    expect(service.settleDelayMs()).toBe(WAKE_SETTLE_MS);

    // The interval keeps ticking every ten seconds once awake.
    for (let elapsed = 0; elapsed < 30_000; elapsed += WAKE_TICK_MS) {
      now += WAKE_TICK_MS;
      service.tick();
    }
    expect(service.settleDelayMs()).toBe(WAKE_SETTLE_MS - 30_000);

    for (
      let elapsed = 30_000;
      elapsed < WAKE_SETTLE_MS;
      elapsed += WAKE_TICK_MS
    ) {
      now += WAKE_TICK_MS;
      service.tick();
    }
    expect(service.settleDelayMs()).toBe(0);
  });

  it("sees the wake even when the overdue cron runs before the detector's tick", () => {
    // On resume both timers are due; the cron may win.
    service.tick();
    now += 5 * 60 * 60_000;
    expect(service.settleDelayMs()).toBe(WAKE_SETTLE_MS);
  });

  it("does not mistake a merely slow tick for a wake", () => {
    service.tick();
    now += WAKE_GAP_MS;
    expect(service.settleDelayMs()).toBe(0);
  });

  it("runs the job at once when nothing woke", async () => {
    const job = jest.fn().mockResolvedValue(undefined);
    await service.afterWakeSettles("Price refresh", job);
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("waits out the settle window before running the job after a wake", async () => {
    jest.useFakeTimers();
    service.tick();
    now += 60 * 60_000;
    const job = jest.fn().mockResolvedValue(undefined);

    const run = service.afterWakeSettles("Price refresh", job);
    await jest.advanceTimersByTimeAsync(WAKE_SETTLE_MS - 1);
    expect(job).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await run;
    expect(job).toHaveBeenCalledTimes(1);
  });

  it("ticks on its own interval once the module starts", () => {
    jest.useFakeTimers();
    service.onModuleInit();
    now += 2 * 60 * 60_000;
    jest.advanceTimersByTime(WAKE_TICK_MS);
    // The interval's tick recorded the wake, so a later check still defers.
    now += 1_000;
    expect(service.settleDelayMs()).toBe(WAKE_SETTLE_MS - 1_000);
  });
});
