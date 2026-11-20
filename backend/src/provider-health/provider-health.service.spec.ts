import { Logger } from "@nestjs/common";
import { ProviderHealthService } from "./provider-health.service";
import { FAILURE_THRESHOLD, OPEN_WINDOW_MS } from "./provider-circuit";
import { ProviderUnavailableError } from "./provider-unavailable.error";
import { MIN_OUTAGE_MS } from "./providers";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () => {
  const actual = jest
    .requireActual("../test-helpers/scoped-db-testing")
    .scopedDbMockModule();
  return actual;
});

jest.mock("../common/db/with-context", () => ({
  withSystemContext: (fn: () => unknown) => fn(),
}));

const PROVIDER = "yahoo_finance";

/** A DNS failure in the exact shape undici produces. */
function transportError(code = "EAI_AGAIN"): Error {
  const error = new TypeError("fetch failed");
  Object.assign(error, {
    cause: Object.assign(
      new Error(`getaddrinfo ${code} query1.finance.yahoo.com`),
      {
        code,
        syscall: "getaddrinfo",
        hostname: "query1.finance.yahoo.com",
      },
    ),
  });
  return error;
}

/** A logger whose calls the test can read. */
function fakeLogger(): jest.Mocked<
  Pick<Logger, "warn" | "log" | "error" | "debug">
> {
  return {
    warn: jest.fn(),
    log: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as never;
}

describe("ProviderHealthService", () => {
  let manager: ManagerMock;
  let dataSource: DataSourceMock;
  let service: ProviderHealthService;
  let now: number;
  let serviceLogger: jest.Mocked<Pick<Logger, "warn" | "log" | "error">>;

  const statements = (): string[] =>
    manager.query.mock.calls.map((call) => String(call[0]));

  const advance = (ms: number) => {
    now += ms;
  };

  /**
   * The health write is deliberately off the caller's path -- fire-and-forget,
   * and chained per provider so a `down` and an `up` cannot land backwards --
   * so a spec that asserts on it has to let the queue drain first.
   */
  const flushWrites = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  /** Drive the breaker open the way an outage does. */
  const driveOpen = () => {
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      service.recordFailure(PROVIDER, transportError());
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
    const mocks = createScopedDbMocks();
    manager = mocks.manager;
    dataSource = mocks.dataSource;
    manager.query.mockResolvedValue([]);
    now = 1_700_000_000_000;
    service = new ProviderHealthService(dataSource as never, () => now);
    serviceLogger = fakeLogger() as never;
    (service as unknown as { logger: unknown }).logger = serviceLogger;
  });

  describe("assertAvailable", () => {
    it("allows calls while the provider answers", () => {
      expect(() => service.assertAvailable(PROVIDER)).not.toThrow();
    });

    it("refuses calls once the breaker opens, without touching the network", () => {
      driveOpen();
      expect(() => service.assertAvailable(PROVIDER)).toThrow(
        ProviderUnavailableError,
      );
    });

    it("names the provider and the wait in the refusal", () => {
      driveOpen();
      advance(15_000);
      let thrown: unknown;
      try {
        service.assertAvailable(PROVIDER);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ProviderUnavailableError);
      const error = thrown as ProviderUnavailableError;
      expect(error.provider).toBe("Yahoo Finance");
      expect(error.retryAfterMs).toBe(OPEN_WINDOW_MS - 15_000);
      expect(error.message).toContain("EAI_AGAIN");
    });

    it("keeps one provider's outage out of the other's way", () => {
      driveOpen();
      expect(() => service.assertAvailable("msn_finance")).not.toThrow();
    });
  });

  describe("recordFailure", () => {
    it("ignores a failure that proves nothing about the provider", () => {
      // The server answered and sent something unparseable: this request's
      // problem. Counting it would take the provider down for everyone.
      for (let i = 0; i < FAILURE_THRESHOLD * 3; i++) {
        service.recordFailure(PROVIDER, new SyntaxError("Unexpected token <"));
      }
      expect(() => service.assertAvailable(PROVIDER)).not.toThrow();
    });

    it("ignores its own refusal, so a refused call cannot deepen the outage", () => {
      driveOpen();
      const refusal = new ProviderUnavailableError("Yahoo Finance", 1000, null);
      service.recordFailure(PROVIDER, refusal);
      expect(service.snapshot(PROVIDER).recentFailures).toBe(FAILURE_THRESHOLD);
    });

    it("logs the outage once, with the cause, when the breaker opens", () => {
      driveOpen();
      expect(serviceLogger.error).toHaveBeenCalledTimes(1);
      const line = String(serviceLogger.error.mock.calls[0][0]);
      expect(line).toContain("Yahoo Finance");
      expect(line).toContain("EAI_AGAIN");
      expect(line).toContain(`${FAILURE_THRESHOLD} transport failures`);
    });

    it("writes the outage to provider_health so it survives the restart", async () => {
      driveOpen();
      await flushWrites();
      const insert = statements().find((sql) =>
        sql.includes("INSERT INTO provider_health"),
      );
      expect(insert).toBeDefined();
      const params = manager.query.mock.calls.find((call) =>
        String(call[0]).includes("INSERT INTO provider_health"),
      )?.[1] as unknown[];
      expect(params[0]).toBe(PROVIDER);
      expect(params[1]).toBe("down");
      // The episode start, not "now": the alert gate reads it.
      expect((params[3] as Date).getTime()).toBe(1_700_000_000_000);
      expect(String(params[5])).toContain("EAI_AGAIN");
    });

    it("preserves an already-recorded episode start in SQL, not in memory", async () => {
      driveOpen();
      await flushWrites();
      const insert = statements().find((sql) =>
        sql.includes("INSERT INTO provider_health"),
      ) as string;
      // A restarted container has a fresh in-memory failingSince, so the clock
      // the alert reads can only be protected by the write itself: only a write
      // that opens an episode may set the start, and only when one is not
      // already recorded.
      expect(insert).toContain("WHEN EXCLUDED.state = 'down'");
      expect(insert).toContain("ELSE provider_health.outage_started_at");
    });

    it("does not write a row for a failure run below the threshold", async () => {
      service.recordFailure(PROVIDER, transportError());
      await flushWrites();
      expect(
        statements().filter((sql) => sql.includes("provider_health")),
      ).toHaveLength(0);
    });

    it("does not write on every failure while it stays down", async () => {
      driveOpen();
      // Twenty minutes of probes failing, one every ten seconds.
      for (let i = 0; i < 120; i++) {
        advance(10_000);
        service.recordFailure(PROVIDER, transportError());
      }
      await flushWrites();
      // One write for the transition, then a heartbeat every five minutes --
      // not one per failed symbol, which is the flood in another form.
      const writes = statements().filter((sql) =>
        sql.includes("INSERT INTO provider_health"),
      );
      expect(writes.length).toBeGreaterThan(1);
      expect(writes.length).toBeLessThanOrEqual(5);
    });

    it("never lets a failed health write break the caller", async () => {
      manager.query.mockRejectedValue(new Error("database is starting up"));
      expect(() => driveOpen()).not.toThrow();
      await new Promise((resolve) => setImmediate(resolve));
      expect(serviceLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Could not record Yahoo Finance health"),
      );
    });
  });

  describe("recordDataFailure and recordDataRecovered", () => {
    const writes = () =>
      manager.query.mock.calls
        .filter((call) =>
          String(call[0]).includes("INSERT INTO provider_health"),
        )
        .map((call) => call[1] as unknown[]);

    it("writes a down row with the reason, without the breaker having opened", async () => {
      service.recordDataFailure(PROVIDER, "newest observation is stale");
      await flushWrites();
      const [params] = writes();
      expect(params[0]).toBe(PROVIDER);
      expect(params[1]).toBe("down");
      expect(String(params[5])).toBe("newest observation is stale");
      expect(service.wouldRefuse(PROVIDER)).toBe(false);
    });

    it("backdates the episode so the alert's evidence gate is already met", async () => {
      // The caller has seen days of stale data and calls once a weekday, so
      // the sweep must not wait for a second failure fifteen minutes later.
      service.recordDataFailure(PROVIDER, "newest observation is stale");
      await flushWrites();
      const [params] = writes();
      expect((params[3] as Date).getTime()).toBe(now - MIN_OUTAGE_MS);
      expect((params[4] as Date).getTime()).toBe(now);
    });

    it("writes an up row on recovery, whichever process recorded the failure", async () => {
      service.recordDataRecovered(PROVIDER);
      await flushWrites();
      const [params] = writes();
      expect(params[1]).toBe("up");
      expect(params[6]).toBeInstanceOf(Date);
    });
  });

  describe("recordSuccess", () => {
    it("says so once when the provider comes back, with what was refused", async () => {
      driveOpen();
      service.assertAvailable.bind(service);
      for (let i = 0; i < 3; i++) {
        try {
          service.assertAvailable(PROVIDER);
        } catch {
          // refused, as expected
        }
      }
      advance(OPEN_WINDOW_MS + 1);
      service.assertAvailable(PROVIDER);
      service.recordSuccess(PROVIDER);
      await flushWrites();

      expect(serviceLogger.log).toHaveBeenCalledTimes(1);
      const line = String(serviceLogger.log.mock.calls[0][0]);
      expect(line).toContain("Yahoo Finance is answering again");
      expect(line).toContain("3 call(s) were refused");
      const healthWrites = manager.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO provider_health"),
      );
      const params = healthWrites[healthWrites.length - 1][1] as unknown[];
      expect(params[1]).toBe("up");
    });

    it("says nothing in the log for a success that follows a success", async () => {
      service.recordSuccess(PROVIDER);
      service.recordSuccess(PROVIDER);
      service.recordSuccess(PROVIDER);
      await flushWrites();
      expect(serviceLogger.log).not.toHaveBeenCalled();
      // One write, from the first success of the process, which is what
      // corrects a row a dead process left saying `down`. Not one per priced
      // symbol.
      expect(
        statements().filter((sql) => sql.includes("provider_health")),
      ).toHaveLength(1);
    });
  });

  describe("logFailure", () => {
    it("carries the cause, the context and the provider on the first line", () => {
      const logger = fakeLogger();
      service.logFailure(
        logger as never,
        PROVIDER,
        "historical prices for ^RUT",
        transportError(),
      );
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const line = String(logger.warn.mock.calls[0][0]);
      expect(line).toContain("Yahoo Finance");
      expect(line).toContain("historical prices for ^RUT");
      expect(line).toContain("EAI_AGAIN");
      expect(line).toContain("hostname=query1.finance.yahoo.com");
    });

    it("collapses a flood into one line a minute, and counts the rest", () => {
      const logger = fakeLogger();
      // 264 chunk fetches failing inside a few seconds -- the bootstrap
      // market-index refresh in issue #1265.
      for (let i = 0; i < 264; i++) {
        service.logFailure(
          logger as never,
          PROVIDER,
          `chunk ${i}`,
          transportError(),
        );
      }
      expect(logger.warn).toHaveBeenCalledTimes(1);

      advance(60_000);
      service.logFailure(
        logger as never,
        PROVIDER,
        "chunk again",
        transportError(),
      );
      expect(logger.warn).toHaveBeenCalledTimes(2);
      expect(String(logger.warn.mock.calls[1][0])).toContain(
        "263 similar failure(s) suppressed",
      );
    });

    it("prints nothing at all for a call the breaker refused", () => {
      const logger = fakeLogger();
      const refusal = new ProviderUnavailableError(
        "Yahoo Finance",
        30_000,
        "EAI_AGAIN",
      );
      for (let i = 0; i < 50; i++) {
        service.logFailure(logger as never, PROVIDER, `chunk ${i}`, refusal);
      }
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      // Nor at debug: nothing in this deployment restricts Nest's log levels
      // (`main.ts`), so a debug line per refused call is the same flood one
      // level quieter.
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it("prints nothing for a suppressed failure either", () => {
      const logger = fakeLogger();
      for (let i = 0; i < 264; i++) {
        service.logFailure(
          logger as never,
          PROVIDER,
          `chunk ${i}`,
          transportError(),
        );
      }
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.debug).not.toHaveBeenCalled();
    });

    it("starts fresh after a recovery rather than reporting a stale count", () => {
      const logger = fakeLogger();
      service.logFailure(logger as never, PROVIDER, "chunk", transportError());
      service.logFailure(logger as never, PROVIDER, "chunk", transportError());
      service.recordSuccess(PROVIDER);
      advance(1_000);
      service.logFailure(logger as never, PROVIDER, "chunk", transportError());
      const lines = logger.warn.mock.calls;
      expect(String(lines[lines.length - 1][0])).not.toContain("suppressed");
    });
  });

  describe("tryRequest", () => {
    it("admits an ordinary call while the provider answers", () => {
      // "open-gate", not "probe": this caller owns no slot and must never
      // release one.
      expect(service.tryRequest(PROVIDER)).toBe("open-gate");
    });

    it("refuses while the window has not elapsed", () => {
      driveOpen();
      expect(service.tryRequest(PROVIDER)).toBe("refused");
    });

    it("takes the probe slot, so a dead provider costs one call per window", () => {
      // A read-only "is it up" gate let every caller past the instant the
      // window elapsed, which is the herd half-open exists to prevent -- and
      // the callers that use this door (MSN, the Yahoo crumb handshake) are
      // exactly the ones with no throw in their contract.
      driveOpen();
      advance(OPEN_WINDOW_MS + 1);
      expect(service.tryRequest(PROVIDER)).toBe("probe");
      expect(service.tryRequest(PROVIDER)).toBe("refused");
      expect(service.tryRequest(PROVIDER)).toBe("refused");
    });

    it("keeps refusing after a post-window failure, not forever admitting", () => {
      driveOpen();
      advance(OPEN_WINDOW_MS + 1);
      expect(service.tryRequest(PROVIDER)).toBe("probe");
      service.recordFailure(PROVIDER, transportError());

      // The bug this pins: the failure left retryAt in the past, so every later
      // check saw an elapsed window and let the call out. The breaker protected
      // for one minute and was then a permanent no-op.
      for (let i = 0; i < 20; i++) {
        advance(1_000);
        expect(service.tryRequest(PROVIDER)).toBe("refused");
      }
    });
  });

  describe("answeredSince", () => {
    it("is true when nothing failed while the caller was asking", () => {
      const before = service.snapshot(PROVIDER);
      expect(service.answeredSince(PROVIDER, before)).toBe(true);
    });

    it("is false when a failure landed while the caller was asking", () => {
      const before = service.snapshot(PROVIDER);
      service.recordFailure(PROVIDER, transportError());
      // One failure, well below the threshold: the breaker is still closed, and
      // the empty result the caller is holding is just as uninformative.
      expect(service.snapshot(PROVIDER).state).toBe("closed");
      expect(service.answeredSince(PROVIDER, before)).toBe(false);
    });

    it("is false when the breaker was already open when the caller started", () => {
      // The call was refused outright. `recordSuccess` does not clear
      // lastFailureAt, so a concurrent probe closing the breaker would make the
      // timestamps match and read as "answered" -- which is why both ends are
      // checked.
      driveOpen();
      const before = service.snapshot(PROVIDER);
      advance(OPEN_WINDOW_MS + 1);
      service.tryRequest(PROVIDER);
      service.recordSuccess(PROVIDER);

      expect(service.snapshot(PROVIDER).state).toBe("closed");
      expect(service.answeredSince(PROVIDER, before)).toBe(false);
    });

    it("answers about one provider, not about the process", () => {
      // Callers that could reach more than one provider do not ask the breakers
      // at all -- the code that made the call reports whether anyone answered
      // (`fillPriceWindow`/`fillRateWindow`), because it knows which providers
      // it reached. So this stays per provider.
      const before = service.snapshot(PROVIDER);
      service.recordFailure("msn_finance", transportError());
      expect(service.answeredSince(PROVIDER, before)).toBe(true);
    });
  });

  describe("releaseProbe", () => {
    it("hands the slot back without claiming to know anything", () => {
      driveOpen();
      advance(OPEN_WINDOW_MS + 1);
      expect(service.tryRequest(PROVIDER)).toBe("probe");
      expect(service.tryRequest(PROVIDER)).toBe("refused");

      service.releaseProbe(PROVIDER);

      // The next caller may probe...
      expect(service.tryRequest(PROVIDER)).toBe("probe");
      // ...and nothing was counted either way: the breaker is still open with
      // the same failure run behind it.
      expect(service.snapshot(PROVIDER).recentFailures).toBe(FAILURE_THRESHOLD);
    });

    it("does nothing at all when no probe is out", () => {
      service.releaseProbe(PROVIDER);
      expect(service.snapshot(PROVIDER).state).toBe("closed");
    });
  });

  describe("wouldRefuse", () => {
    it("reads without taking the slot", () => {
      driveOpen();
      advance(OPEN_WINDOW_MS + 1);
      expect(service.wouldRefuse(PROVIDER)).toBe(false);
      expect(service.wouldRefuse(PROVIDER)).toBe(false);
      // The probe is still there for the caller that actually makes a request.
      expect(service.tryRequest(PROVIDER)).toBe("probe");
    });

    it("is true while the window has not elapsed", () => {
      driveOpen();
      expect(service.wouldRefuse(PROVIDER)).toBe(true);
    });

    it("is false while the provider answers", () => {
      expect(service.wouldRefuse(PROVIDER)).toBe(false);
    });
  });

  describe("after a restart inside an outage", () => {
    /** A process that starts with a closed breaker, as every restart does. */
    const restarted = () => {
      const fresh = new ProviderHealthService(dataSource as never, () => now);
      (fresh as unknown as { logger: unknown }).logger = fakeLogger();
      return fresh;
    };

    it("records the provider as up on its first success, transition or not", async () => {
      // The row was left saying `down` by the process that died. Nothing else
      // will ever correct it: a success in a fresh process is not a transition,
      // notifyRecovery needs state='up', and the outage claim needs
      // outage_notified_at IS NULL -- so both the all-clear and every future
      // outage alert for this provider would be lost.
      const fresh = restarted();
      fresh.recordSuccess(PROVIDER);
      await flushWrites();

      const writes = manager.query.mock.calls.filter((call) =>
        String(call[0]).includes("INSERT INTO provider_health"),
      );
      expect(writes).toHaveLength(1);
      expect((writes[0][1] as unknown[])[1]).toBe("up");
    });

    it("is silent for every success after the first", async () => {
      const fresh = restarted();
      for (let i = 0; i < 500; i++) fresh.recordSuccess(PROVIDER);
      await flushWrites();
      expect(
        manager.query.mock.calls.filter((call) =>
          String(call[0]).includes("INSERT INTO provider_health"),
        ),
      ).toHaveLength(1);
    });

    it("leaves the stored episode start alone, so the alert clock survives", async () => {
      const fresh = restarted();
      fresh.recordSuccess(PROVIDER);
      await flushWrites();
      const insert = String(
        manager.query.mock.calls.find((call) =>
          String(call[0]).includes("INSERT INTO provider_health"),
        )?.[0],
      );
      // An `up` write carries no episode start, and must not clear the stored
      // one: a restart between the recovery write and the alert sweep would
      // otherwise leave the all-clear reporting an outage that lasted 0 min.
      expect(insert).toContain("ELSE provider_health.outage_started_at");
    });
  });
});
