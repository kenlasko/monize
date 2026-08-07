import { AiUsageService } from "./ai-usage.service";
import { AiInsightsService } from "./insights/ai-insights.service";
import { AiUsageLog } from "./entities/ai-usage-log.entity";
import { AiInsight } from "./entities/ai-insight.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { createJobClaimMock } from "../test-helpers/job-claim-testing";

/**
 * RLS smoke for the AI module's cron entry points (task R6).
 *
 * Unlike the per-service specs, this suite does NOT mock `withScopedDb`: the
 * real implementation runs (at the default RLS_MODE=off), so every DB access on
 * the cron paths must find the ambient context seeded by the C2 wrappers
 * (withSystemContext / withUserContext) or withScopedDb throws its
 * missing-context error. This is the CI stand-in for the "dev smoke of the
 * module's cron paths shows no context throws" acceptance.
 */
describe("ai module RLS context smoke (real withScopedDb)", () => {
  const USER_ID = "5c9a1e77-8b32-4d0f-a1c6-7e4b2d9f0a35";

  it("purgeOldUsageLogs runs its cross-user delete under the system context", async () => {
    const usageRepo = { delete: jest.fn().mockResolvedValue({ affected: 3 }) };
    const { dataSource } = createScopedDbMocks([[AiUsageLog, usageRepo]]);

    const service = new AiUsageService(dataSource as never);
    const errorSpy = jest
      .spyOn(service["logger"], "error")
      .mockImplementation(() => undefined);

    // The handler catches internally -- a missing ambient context would surface
    // as a logged "DB access outside request/user/system context" error.
    await service.purgeOldUsageLogs();

    expect(errorSpy).not.toHaveBeenCalled();
    expect(usageRepo.delete).toHaveBeenCalled();
  });

  it("handleDailyInsightGeneration runs cleanup + fan-out under their contexts", async () => {
    const insightRepo = {
      delete: jest.fn().mockResolvedValue({ affected: 0 }),
      createQueryBuilder: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
    };
    const { manager, dataSource } = createScopedDbMocks([
      [AiInsight, insightRepo],
      [UserPreference, { findOne: jest.fn() }],
    ]);
    manager.createQueryBuilder.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue([{ userId: USER_ID }]),
    });

    const generated: string[] = [];
    const service = new AiInsightsService(
      dataSource as never,
      {} as never,
      {} as never,
      {} as never,
      { get: jest.fn().mockReturnValue(undefined) } as never,
      createJobClaimMock() as never,
    );
    jest
      .spyOn(service, "generateInsights")
      .mockImplementation(async (userId: string) => {
        generated.push(userId);
        return {} as never;
      });
    const warnSpy = jest
      .spyOn(service["logger"], "warn")
      .mockImplementation(() => undefined);

    await service.handleDailyInsightGeneration();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(insightRepo.delete).toHaveBeenCalled();
    expect(generated).toEqual([USER_ID]);
  });

  it("real withScopedDb still refuses these paths without their context wrappers", async () => {
    const { dataSource } = createScopedDbMocks([
      [AiUsageLog, { create: jest.fn((d) => d), save: jest.fn() }],
    ]);
    const service = new AiUsageService(dataSource as never);

    // Called with no ambient scope at all (no interceptor, no wrapper): the real
    // withScopedDb must throw, proving the smokes above pass because of the C2
    // wrappers and not because the check is inert.
    await expect(
      service.logUsage({
        userId: USER_ID,
        provider: "anthropic",
        model: "m",
        feature: "insight",
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 1,
      }),
    ).rejects.toThrow("DB access outside request/user/system context");
  });
});
