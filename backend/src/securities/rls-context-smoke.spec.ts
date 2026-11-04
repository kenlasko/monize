import { HoldingsService } from "./holdings.service";
import { SecurityPriceService } from "./security-price.service";
import { Account } from "../accounts/entities/account.entity";
import { Holding } from "./entities/holding.entity";
import { InvestmentTransaction } from "./entities/investment-transaction.entity";
import { Security } from "./entities/security.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { createFetchSyncMock } from "../test-helpers/job-claim-testing";

/**
 * RLS smoke for the securities module's cron entry points (task R3).
 *
 * Unlike the per-service specs, this suite does NOT mock `withScopedDb`: the
 * real implementation runs (at the default RLS_MODE=off), so every DB access on
 * the cron paths must find the ambient context seeded by the C2 wrappers
 * (withSystemContext / withUserContext) or withScopedDb throws its
 * missing-context error. This is the CI stand-in for the "dev smoke of the
 * module's cron paths shows no context throws" acceptance.
 */
describe("securities module RLS context smoke (real withScopedDb)", () => {
  const OWNER_ID = "3f1f8a52-2f0e-4b6d-9a56-0d6a3f1c2b4e";

  it("applyMaturedInvestmentHoldings runs fan-out and per-user rebuilds under their contexts", async () => {
    const accountsRepo = {
      find: jest.fn().mockResolvedValue([
        {
          id: "acc-1",
          userId: OWNER_ID,
          accountType: "INVESTMENT",
          accountSubType: "INVESTMENT_BROKERAGE",
        },
      ]),
    };
    const txRepo = { find: jest.fn().mockResolvedValue([]) };
    const { manager, dataSource } = createScopedDbMocks([
      [Account, accountsRepo],
      [InvestmentTransaction, txRepo],
      [Holding, { create: jest.fn(), save: jest.fn() }],
    ]);
    // The timezone fan-out and the matured-user scan both run inside the cron's
    // system context, each in its own withScopedDb.
    manager.query
      .mockResolvedValueOnce([
        { user_id: OWNER_ID, timezone: "UTC", last_client_timezone: null },
      ])
      .mockResolvedValue([{ user_id: OWNER_ID }]);
    manager.find.mockResolvedValue([]);

    const service = new HoldingsService(
      {} as never,
      {} as never,
      dataSource as never,
    );
    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    // The handler catches internally -- a missing ambient context would surface
    // as a logged "DB access outside request/user/system context" error.
    await service.applyMaturedInvestmentHoldings();

    expect(errorSpy).not.toHaveBeenCalled();
    // The per-user rebuild actually ran inside its withUserContext scope.
    expect(accountsRepo.find).toHaveBeenCalled();
    expect(txRepo.find).toHaveBeenCalled();
  });

  it("scheduledPriceRefresh reads its securities under the system context", async () => {
    const securitiesRepo = { find: jest.fn().mockResolvedValue([]) };
    const { dataSource } = createScopedDbMocks([
      [Security, securitiesRepo],
      [UserPreference, { find: jest.fn().mockResolvedValue([]) }],
    ]);

    const service = new SecurityPriceService(
      dataSource as never,
      { recalculateAllInvestmentSnapshots: jest.fn() } as never,
      {} as never,
      createFetchSyncMock() as never,
    );
    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    await service.scheduledPriceRefresh();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(securitiesRepo.find).toHaveBeenCalledWith({
      where: { isActive: true },
    });
  });

  it("scheduledWeekendCryptoRefresh reads its securities under the system context", async () => {
    const securitiesRepo = { find: jest.fn().mockResolvedValue([]) };
    const { dataSource } = createScopedDbMocks([
      [Security, securitiesRepo],
      [UserPreference, { find: jest.fn().mockResolvedValue([]) }],
    ]);

    const service = new SecurityPriceService(
      dataSource as never,
      { recalculateAllInvestmentSnapshots: jest.fn() } as never,
      {} as never,
      createFetchSyncMock() as never,
    );
    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    await service.scheduledWeekendCryptoRefresh();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(securitiesRepo.find).toHaveBeenCalledWith({
      where: { isActive: true, securityType: "CRYPTO" },
    });
  });

  it("refreshAllPrices supplies its own system context", async () => {
    // It used to depend on the caller's wrapper, which meant the admin
    // maintenance endpoint read `securities` in the admin's own scope: global at
    // RLS_MODE=off and silently narrowed to their own holdings at enforce. The
    // scope is a property of the operation now, so it runs with no ambient
    // context at all.
    const { dataSource } = createScopedDbMocks([
      [Security, { find: jest.fn().mockResolvedValue([]) }],
    ]);
    const service = new SecurityPriceService(
      dataSource as never,
      {} as never,
      {} as never,
      createFetchSyncMock() as never,
    );

    await expect(service.refreshAllPrices()).resolves.toMatchObject({
      totalSecurities: 0,
    });
  });

  it("real withScopedDb still refuses a per-user path without its context", async () => {
    // The negative control: `refreshPricesForSecurities` is the caller-scoped
    // counterpart (its controller verifies ownership of every id first), so it
    // must still fail closed with no ambient identity -- proving the smokes above
    // pass because of real context wrappers and not because the check is inert.
    const { dataSource } = createScopedDbMocks([
      [Security, { find: jest.fn() }],
    ]);
    const service = new SecurityPriceService(
      dataSource as never,
      {} as never,
      {} as never,
      createFetchSyncMock() as never,
    );

    await expect(
      service.refreshPricesForSecurities([
        "11111111-1111-4111-8111-111111111111",
      ]),
    ).rejects.toThrow("DB access outside request/user/system context");
  });
});
