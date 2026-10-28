jest.mock("../accruals/reporting-basis", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingBasisMockModule(),
);
import { NetWorthService } from "./net-worth.service";
import { Account } from "../accounts/entities/account.entity";
import { MonthlyAccountBalance } from "./entities/monthly-account-balance.entity";
import { requestContextStorage } from "../common/request-context";
import { runWithActiveScopedManager } from "../common/db/scoped-db";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/**
 * RLS smoke for the net-worth module's out-of-request entry point (task R3).
 *
 * This suite deliberately does NOT mock `withScopedDb`: the real implementation
 * runs (at the default RLS_MODE=off), so a missing ambient context or a stale
 * ambient EntityManager surfaces here instead of in production.
 *
 * Real timers on purpose. AsyncLocalStorage propagates into a `setTimeout`
 * callback because the timer is a real async resource; jest's fake timers
 * invoke the callback directly and would make the propagation assertion
 * vacuous. The debounce window is shortened instead of being waited out.
 */
describe("net-worth module RLS context smoke (real withScopedDb)", () => {
  const OWNER_ID = "3f1f8a52-2f0e-4b6d-9a56-0d6a3f1c2b4e";

  const originalDebounce = (
    NetWorthService as unknown as { RECALC_DEBOUNCE_MS: number }
  ).RECALC_DEBOUNCE_MS;

  beforeAll(() => {
    (
      NetWorthService as unknown as { RECALC_DEBOUNCE_MS: number }
    ).RECALC_DEBOUNCE_MS = 5;
  });

  afterAll(() => {
    (
      NetWorthService as unknown as { RECALC_DEBOUNCE_MS: number }
    ).RECALC_DEBOUNCE_MS = originalDebounce;
  });

  it("does not carry the caller's transaction manager into the debounced recalc", async () => {
    // The regression: several callers (TransactionSplitService.createSplits and
    // friends) trigger the recalc from inside their own withScopedDb block. A
    // timer scheduled there would inherit that block's EntityManager through
    // the scoped-manager ALS and fire after the transaction had committed and
    // its connection had gone back to the pool.
    const accountsRepo = { findOne: jest.fn().mockResolvedValue(null) };
    const { dataSource } = createScopedDbMocks([
      [Account, accountsRepo],
      [MonthlyAccountBalance, {}],
    ]);
    const service = new NetWorthService(dataSource as never);

    const callerManager = {
      getRepository: () => {
        throw new Error("recalc joined the caller's committed transaction");
      },
    } as never;

    requestContextStorage.run({ userId: OWNER_ID }, () => {
      runWithActiveScopedManager(callerManager, () => {
        service.triggerDebouncedRecalc("acc-1", OWNER_ID);
      });
    });

    await waitFor(() => accountsRepo.findOne.mock.calls.length > 0);

    // The recalc opened its own transaction rather than joining the caller's,
    // and found the request context the timer inherited.
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(accountsRepo.findOne).toHaveBeenCalledWith({
      where: { id: "acc-1", userId: OWNER_ID },
    });
  });

  it("real withScopedDb still refuses a net-worth read with no ambient context", async () => {
    const { dataSource } = createScopedDbMocks([
      [Account, { findOne: jest.fn() }],
    ]);
    const service = new NetWorthService(dataSource as never);

    // Proves the assertion above passes because the request context propagates
    // into the timer, not because the context check is inert.
    await expect(service.recalculateAccount(OWNER_ID, "acc-1")).rejects.toThrow(
      "DB access outside request/user/system context",
    );
  });
});

/** Poll until `predicate` holds, so the test never sleeps longer than it must. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for the debounced recalc to run");
}
