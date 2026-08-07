import { TokenService } from "./token.service";
import { AutoBackupService } from "../backup/auto-backup.service";
import { EmergencyAccessMonitorService } from "../emergency-access/emergency-access-monitor.service";
import { AccountDelegateGuard } from "../delegation/guards/account-delegate.guard";
import { RefreshToken } from "./entities/refresh-token.entity";
import { User } from "../users/entities/user.entity";
import { AutoBackupSettings } from "../backup/entities/auto-backup-settings.entity";
import { EmergencyAccessSettings } from "../emergency-access/entities/emergency-access-settings.entity";
import { getRequestContext } from "../common/request-context";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

/**
 * RLS smoke for the R7 modules' out-of-request entry points (task R7).
 *
 * Unlike the per-service specs, this suite does NOT mock `withScopedDb`: the
 * real implementation runs (at the default RLS_MODE=off), so every DB access on
 * these paths must find the ambient context seeded by the C1-C4 wrappers, or
 * withScopedDb throws its missing-context error. This is the CI stand-in for the
 * "dev smoke of the module's cron/bootstrap paths shows no context throws"
 * acceptance.
 *
 * The guard case is the one that is not a cron: global guards run *before*
 * `AuthGuard('jwt')` and before the RequestContextInterceptor's scope exists, so
 * `AccountDelegateGuard`'s DelegationService reads had no identity at all once
 * this task converted them. It seeds both GUCs (current = owner, real =
 * delegate), which is what the delegation policies expect.
 */
describe("R7 modules RLS context smoke (real withScopedDb)", () => {
  const OWNER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  const DELEGATE_ID = "d1a2b3c4-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

  it("purgeExpiredRefreshTokens runs its bulk deletes under the system context", async () => {
    const refreshRepo = {
      delete: jest.fn().mockResolvedValue({ affected: 2 }),
    };
    const { dataSource } = createScopedDbMocks([[RefreshToken, refreshRepo]]);

    const service = new TokenService(
      {} as never,
      dataSource as never,
      { get: jest.fn() } as never,
    );

    await service.purgeExpiredRefreshTokens();

    expect(refreshRepo.delete).toHaveBeenCalledTimes(2);
  });

  it("handleAutoBackupCron reads its due-settings fan-out under the system context", async () => {
    const settingsRepo = { find: jest.fn().mockResolvedValue([]) };
    const usersRepo = { find: jest.fn().mockResolvedValue([]) };
    const { dataSource } = createScopedDbMocks([
      [AutoBackupSettings, settingsRepo],
      [User, usersRepo],
    ]);

    const service = new AutoBackupService(
      dataSource as never,
      {} as never,
      {} as never,
      { isDemo: false } as never,
      { isUnderMaintenance: jest.fn().mockResolvedValue(false) } as never,
      { get: jest.fn() } as never,
    );

    await service.handleAutoBackupCron();

    expect(settingsRepo.find).toHaveBeenCalled();
  });

  it("emergency-access runDailyCheck sweeps under the system context", async () => {
    const settingsRepo = { find: jest.fn().mockResolvedValue([]) };
    const { dataSource } = createScopedDbMocks([
      [EmergencyAccessSettings, settingsRepo],
    ]);

    const service = new EmergencyAccessMonitorService(
      dataSource as never,
      { getStatus: jest.fn().mockReturnValue({ configured: true }) } as never,
      {} as never,
      { get: jest.fn() } as never,
      {} as never,
    );

    await service.runDailyCheck();

    expect(settingsRepo.find).toHaveBeenCalled();
  });

  it("AccountDelegateGuard seeds owner + delegate before its grant lookups", async () => {
    let ctxAtLookup: ReturnType<typeof getRequestContext>;
    const delegationService = {
      hasAccountPermission: jest.fn().mockImplementation(() => {
        ctxAtLookup = getRequestContext();
        return Promise.resolve(true);
      }),
    };
    const guard = new AccountDelegateGuard(
      {
        // Only the @AllowDelegate flag and the account-param key are set; the
        // transfer/scheduled/capability keys stay undefined.
        getAllAndOverride: jest.fn((key: string) =>
          key === "allowDelegate"
            ? true
            : key === "delegatedAccountParam"
              ? "id"
              : undefined,
        ),
      } as never,
      {
        verify: jest.fn().mockReturnValue({
          sub: DELEGATE_ID,
          actingAsUserId: OWNER_ID,
          delegationId: "11111111-1111-4111-8111-111111111111",
        }),
      } as never,
      delegationService as never,
      { isAccountOwnedBy: jest.fn().mockResolvedValue(false) } as never,
    );

    const context = {
      getType: () => "http",
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: "Bearer token" },
          params: { id: "22222222-2222-4222-8222-222222222222" },
        }),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    };

    await expect(guard.canActivate(context as never)).resolves.toBe(true);

    // Both GUCs, not one: `withUserContext` alone would collapse the delegate
    // and the owner onto a single id, and the special policies M2 wrote for
    // delegation need them to differ.
    expect(ctxAtLookup).toEqual({
      userId: OWNER_ID,
      realUserId: DELEGATE_ID,
    });
  });

  it("real withScopedDb still refuses these paths without their context wrappers", async () => {
    const { dataSource } = createScopedDbMocks([
      [RefreshToken, { update: jest.fn() }],
    ]);
    const service = new TokenService(
      {} as never,
      dataSource as never,
      { get: jest.fn() } as never,
    );

    // Called with no ambient scope at all (no interceptor, no wrapper): the real
    // withScopedDb must throw, proving the smokes above pass because of the
    // wrappers and not because the check is inert.
    await expect(service.revokeAllUserRefreshTokens(OWNER_ID)).rejects.toThrow(
      "DB access outside request/user/system context",
    );
  });
});
