import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiActionsService } from "./ai-actions.service";
import { AiActionSigningService } from "./ai-action-signing.service";
import { AiWriteLimiter } from "./ai-write-limiter";
import { AiActionDescriptor } from "./ai-action.types";
import { ConfirmAiActionDto } from "./dto/confirm-ai-action.dto";
import {
  createSingleUseTokenMock,
  type SingleUseTokenMock,
} from "../../test-helpers/single-use-token-testing";
import {
  createAuthAttemptCounterMock,
  type AuthAttemptCounterMock,
} from "../../test-helpers/auth-attempt-counter-testing";
import { AuthAttemptCounterService } from "../../auth/auth-attempt-counter.service";

const USER = "user-1";
const RULE = "e0000000-0000-4000-8000-000000000005";
const CAT = "c0000000-0000-4000-8000-000000000003";
const PAYEE = "b0000000-0000-4000-8000-000000000002";
const ACC = "a0000000-0000-4000-8000-000000000001";
const FINGERPRINT = "f".repeat(64);

const definition = {
  name: "Streaming",
  enabled: true,
  triggers: ["create", "import"] as ("create" | "import")[],
  stopProcessing: false,
  activeFrom: "2026-10-01" as string | null,
  activeTo: null as string | null,
  condition: { field: "payeeId", op: "eq", value: PAYEE } as const,
  actions: [
    { type: "set_category", categoryId: CAT, onlyIfEmpty: true },
  ] as const,
};

describe("AiActionsService transaction rule actions", () => {
  let service: AiActionsService;
  let signing: AiActionSigningService;
  let counters: AuthAttemptCounterMock;
  let singleUseTokens: SingleUseTokenMock;
  let rules: Record<string, jest.Mock>;
  let runs: Record<string, jest.Mock>;

  beforeEach(() => {
    signing = new AiActionSigningService({
      get: jest
        .fn()
        .mockReturnValue("test-secret-key-at-least-32-chars-long!!"),
    } as unknown as ConfigService);
    counters = createAuthAttemptCounterMock();
    singleUseTokens = createSingleUseTokenMock();
    rules = {
      create: jest.fn().mockResolvedValue({ id: RULE }),
      update: jest.fn().mockResolvedValue({ id: RULE }),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    runs = {
      run: jest.fn().mockResolvedValue({
        changed: 3,
        skipped: [{ transactionId: "t-9", reason: "reconciled_locked" }],
        historyId: "h-1",
      }),
    };
    service = new AiActionsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      signing,
      new AiWriteLimiter(counters as unknown as AuthAttemptCounterService),
      {} as never,
      {} as never,
      singleUseTokens as never,
      rules as never,
      runs as never,
      {} as never,
    );
  });

  const envelope = (actionId: string) => ({
    userId: USER,
    actionId,
    expiresAt: Date.now() + 60_000,
  });

  function dtoFor(descriptor: AiActionDescriptor): ConfirmAiActionDto {
    return {
      actionId: descriptor.actionId,
      signature: signing.sign(descriptor),
      descriptor: descriptor as unknown as Record<string, unknown>,
    };
  }

  const createDescriptor = (): AiActionDescriptor => ({
    type: "create_transaction_rule",
    ...envelope("act-create-rule"),
    rule: { ...definition, actions: [...definition.actions] },
  });
  const updateDescriptor = (): AiActionDescriptor => ({
    type: "update_transaction_rule",
    ...envelope("act-update-rule"),
    ruleId: RULE,
    expectedRevision: 4,
    rule: { ...definition, name: "Renamed", actions: [...definition.actions] },
  });
  const deleteDescriptor = (): AiActionDescriptor => ({
    type: "delete_transaction_rule",
    ...envelope("act-delete-rule"),
    ruleId: RULE,
    expectedRevision: 4,
  });
  const runDescriptor = (): AiActionDescriptor => ({
    type: "run_transaction_rule",
    ...envelope("act-run-rule"),
    ruleId: RULE,
    filters: { accountIds: [ACC], startDate: "2026-01-01", limit: 50 },
    fingerprint: FINGERPRINT,
  });

  it("creates the rule through the rules service with the descriptor's definition", async () => {
    const result = await service.confirm(USER, dtoFor(createDescriptor()));

    expect(rules.create).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({
        name: "Streaming",
        enabled: true,
        triggers: ["create", "import"],
        stopProcessing: false,
        activeFrom: "2026-10-01",
        activeTo: null,
        condition: definition.condition,
        actions: definition.actions,
      }),
    );
    expect(result).toEqual({ type: "create_transaction_rule", id: RULE });
  });

  it("confirms a descriptor signed before the window existed without touching the stored window", async () => {
    const { activeFrom: _from, activeTo: _to, ...old } = definition;
    const descriptor = {
      ...updateDescriptor(),
      rule: { ...old, actions: [...definition.actions] },
    } as AiActionDescriptor;

    await service.confirm(USER, dtoFor(descriptor));

    const dto = rules.update.mock.calls[0][2];
    expect(dto.activeFrom).toBeUndefined();
    expect(dto.activeTo).toBeUndefined();
  });

  it("updates the window with the rest of the rule", async () => {
    await service.confirm(
      USER,
      dtoFor({
        ...updateDescriptor(),
        rule: {
          ...definition,
          activeTo: "2026-12-31",
          actions: [...definition.actions],
        },
      } as AiActionDescriptor),
    );
    expect(rules.update).toHaveBeenCalledWith(
      USER,
      RULE,
      expect.objectContaining({
        activeFrom: "2026-10-01",
        activeTo: "2026-12-31",
      }),
    );
  });

  it("updates with the revision the card was built from", async () => {
    const result = await service.confirm(USER, dtoFor(updateDescriptor()));

    expect(rules.update).toHaveBeenCalledWith(
      USER,
      RULE,
      expect.objectContaining({ name: "Renamed", revision: 4 }),
    );
    expect(result).toEqual({ type: "update_transaction_rule", id: RULE });
  });

  it("surfaces a stale revision as the service's 409 and releases the claim", async () => {
    rules.update.mockRejectedValue(
      new ConflictException({ errorCode: "REVISION_CONFLICT" }),
    );
    await expect(
      service.confirm(USER, dtoFor(updateDescriptor())),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(singleUseTokens.release).toHaveBeenCalled();
  });

  it("deletes only at the revision the card showed", async () => {
    const result = await service.confirm(USER, dtoFor(deleteDescriptor()));

    expect(rules.remove).toHaveBeenCalledWith(USER, RULE, 4);
    expect(result).toEqual({ type: "delete_transaction_rule", id: RULE });
  });

  it("surfaces a delete of a rule that changed as the service's refusal", async () => {
    rules.remove.mockRejectedValue(
      new ConflictException({ errorCode: "REVISION_CONFLICT" }),
    );
    await expect(
      service.confirm(USER, dtoFor(deleteDescriptor())),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("runs the rule with the descriptor's filters and fingerprint and reports the result", async () => {
    const result = await service.confirm(USER, dtoFor(runDescriptor()));

    expect(runs.run).toHaveBeenCalledWith(
      USER,
      RULE,
      expect.objectContaining({
        accountIds: [ACC],
        startDate: "2026-01-01",
        limit: 50,
        fingerprint: FINGERPRINT,
      }),
    );
    expect(result).toEqual({
      type: "run_transaction_rule",
      id: RULE,
      ruleRun: {
        changed: 3,
        skipped: [{ transactionId: "t-9", reason: "reconciled_locked" }],
        historyId: "h-1",
      },
    });
  });

  it("commits a descriptor built in this process through the same executors, without the confirm endpoint's claim", async () => {
    const descriptor = runDescriptor();
    const result = await service.commitApproved(USER, descriptor);
    expect(runs.run).toHaveBeenCalledTimes(1);
    expect(result.type).toBe("run_transaction_rule");
    expect(singleUseTokens.claim).not.toHaveBeenCalled();
  });

  it("counts a run as one write however many rows it changed", async () => {
    const limiter = new AiWriteLimiter(
      counters as unknown as AuthAttemptCounterService,
    );
    service = new AiActionsService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      signing,
      limiter,
      {} as never,
      {} as never,
      singleUseTokens as never,
      rules as never,
      runs as never,
      {} as never,
    );
    await service.confirm(USER, dtoFor(runDescriptor()));
    expect((await limiter.checkLimit(USER)).currentCount).toBe(1);
  });

  it("refuses a PREVIEW_CHANGED run as the user's refusal, with nothing written and the claim released", async () => {
    runs.run.mockRejectedValue(
      new ConflictException({
        message: "The transactions or the rule changed since the preview.",
        errorCode: "PREVIEW_CHANGED",
        fingerprint: "0".repeat(64),
      }),
    );
    const failure = await service
      .confirm(USER, dtoFor(runDescriptor()))
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(ConflictException);
    expect((failure as ConflictException).getResponse()).toMatchObject({
      errorCode: "PREVIEW_CHANGED",
    });
    expect(singleUseTokens.release).toHaveBeenCalled();
  });

  it("refuses a run whose fingerprint is not a plan hash before calling the run service", async () => {
    const descriptor = {
      ...runDescriptor(),
      fingerprint: "not-a-hash",
    } as AiActionDescriptor;
    await expect(
      service.confirm(USER, dtoFor(descriptor)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runs.run).not.toHaveBeenCalled();
  });

  it("refuses a run naming a non-UUID account without running", async () => {
    const descriptor = {
      ...runDescriptor(),
      filters: { accountIds: ["not-a-uuid"] },
    } as AiActionDescriptor;
    await expect(
      service.confirm(USER, dtoFor(descriptor)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(runs.run).not.toHaveBeenCalled();
  });

  it.each([
    ["create", createDescriptor],
    ["update", updateDescriptor],
    ["delete", deleteDescriptor],
    ["run", runDescriptor],
  ])(
    "%s: a descriptor minted for another user is refused and writes nothing",
    async (_name, make) => {
      const descriptor = { ...make(), userId: "user-2" } as AiActionDescriptor;
      await expect(
        service.confirm(USER, dtoFor(descriptor)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      for (const fn of [rules.create, rules.update, rules.remove, runs.run]) {
        expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["create", createDescriptor],
    ["update", updateDescriptor],
    ["delete", deleteDescriptor],
    ["run", runDescriptor],
  ])("%s: a tampered descriptor fails the signature", async (_name, make) => {
    const descriptor = make();
    const dto = dtoFor(descriptor);
    (dto.descriptor as Record<string, unknown>).userId = USER;
    (dto.descriptor as Record<string, unknown>).ruleId = "other";
    await expect(service.confirm(USER, dto)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(rules.remove).not.toHaveBeenCalled();
    expect(runs.run).not.toHaveBeenCalled();
  });

  it("re-validates a definition the descriptor carries: a rule name over the bound is refused before the service", async () => {
    const descriptor = {
      ...createDescriptor(),
      rule: { ...definition, name: "x".repeat(101), actions: [] },
    } as AiActionDescriptor;
    await expect(
      service.confirm(USER, dtoFor(descriptor)),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rules.create).not.toHaveBeenCalled();
  });

  it("leaves ownership of the rule and of every id in it to the rules service's own transaction", async () => {
    rules.update.mockRejectedValue(new NotFoundException("gone"));
    await expect(
      service.confirm(USER, dtoFor(updateDescriptor())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
