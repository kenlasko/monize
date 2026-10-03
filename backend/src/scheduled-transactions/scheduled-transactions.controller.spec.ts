import { Test, TestingModule } from "@nestjs/testing";
import { ScheduledTransactionsController } from "./scheduled-transactions.controller";
import { ScheduledTransactionsService } from "./scheduled-transactions.service";
import { DelegationService } from "../delegation/delegation.service";
import { JointAccountsService } from "../delegation/joint-accounts.service";

describe("ScheduledTransactionsController", () => {
  let controller: ScheduledTransactionsController;
  let mockService: Record<string, jest.Mock>;
  let delegationMock: Record<string, jest.Mock>;
  let jointMock: Record<string, jest.Mock>;
  const mockReq = { user: { id: "user-1" } };

  beforeEach(async () => {
    mockService = {
      create: jest.fn(),
      findAll: jest.fn(),
      findDue: jest.fn(),
      findUpcoming: jest.fn(),
      findEffectiveOccurrences: jest.fn(),
      findOne: jest.fn(),
      update: jest.fn(),
      remove: jest.fn(),
      post: jest.fn(),
      skip: jest.fn(),
      getLoanProjectionAnchor: jest.fn(),
      findOverrides: jest.fn(),
      hasOverrides: jest.fn(),
      findOverrideByDate: jest.fn(),
      createOverride: jest.fn(),
      findOverride: jest.fn(),
      updateOverride: jest.fn(),
      removeOverride: jest.fn(),
      removeAllOverrides: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ScheduledTransactionsController],
      providers: [
        {
          provide: ScheduledTransactionsService,
          useValue: mockService,
        },
        {
          // The anchor route falls back to joint access, as GET
          // /accounts/:id/balance does, so a jointly shared loan is not
          // reported as "has no scheduled payment".
          provide: JointAccountsService,
          useValue: (jointMock = {
            jointAccountIdSetFor: jest
              .fn()
              .mockResolvedValue(new Set<string>()),
            jointAccessFor: jest.fn(),
          }),
        },
        {
          provide: DelegationService,
          useValue: (delegationMock = {
            readableAccountIds: jest.fn().mockResolvedValue([]),
            accountIdsForScheduled: jest.fn().mockResolvedValue([]),
          }),
        },
      ],
    }).compile();

    controller = module.get<ScheduledTransactionsController>(
      ScheduledTransactionsController,
    );
  });

  describe("create()", () => {
    it("delegates to service.create with userId and dto", async () => {
      const dto = { payeeId: "p1", amount: 100 };
      const expected = { id: "st-1", payeeId: "p1" };
      mockService.create.mockResolvedValue(expected);

      const result = await controller.create(mockReq, dto as any);

      expect(result).toEqual(expected);
      expect(mockService.create).toHaveBeenCalledWith("user-1", dto);
    });
  });

  describe("findAll()", () => {
    it("delegates to service.findAll with userId", async () => {
      const expected = [{ id: "st-1" }];
      mockService.findAll.mockResolvedValue(expected);

      const result = await controller.findAll(mockReq);

      expect(result).toEqual(expected);
      expect(mockService.findAll).toHaveBeenCalledWith("user-1");
    });

    it("filters to readable accounts for an acting delegate", async () => {
      const actingReq = {
        user: { id: "owner-1", isActing: true, delegationId: "g1" },
      };
      mockService.findAll.mockResolvedValue([
        { id: "st-1", accountId: "a1" },
        { id: "st-2", accountId: "a2" },
      ]);
      delegationMock.readableAccountIds.mockResolvedValue(["a2"]);

      const result = await controller.findAll(actingReq);

      expect(result).toEqual([{ id: "st-2", accountId: "a2" }]);
      expect(delegationMock.readableAccountIds).toHaveBeenCalledWith("g1");
    });

    it("keeps a transfer where the delegate holds the recipient side", async () => {
      const actingReq = {
        user: { id: "owner-1", isActing: true, delegationId: "g1" },
      };
      mockService.findAll.mockResolvedValue([
        // source unreadable, recipient readable -> visible (masked)
        {
          id: "st-1",
          accountId: "a1",
          isTransfer: true,
          transferAccountId: "a2",
        },
        // neither side readable -> hidden
        {
          id: "st-2",
          accountId: "a3",
          isTransfer: true,
          transferAccountId: "a4",
        },
        // non-transfer on an unreadable account -> hidden
        { id: "st-3", accountId: "a1", isTransfer: false },
      ]);
      delegationMock.readableAccountIds.mockResolvedValue(["a2"]);

      const result = await controller.findAll(actingReq);

      expect(result).toEqual([
        {
          id: "st-1",
          accountId: "a1",
          isTransfer: true,
          transferAccountId: "a2",
        },
      ]);
    });
  });

  describe("findDue()", () => {
    it("delegates to service.findDue with userId", async () => {
      const expected = [{ id: "st-1", isDue: true }];
      mockService.findDue.mockResolvedValue(expected);

      const result = await controller.findDue(mockReq);

      expect(result).toEqual(expected);
      expect(mockService.findDue).toHaveBeenCalledWith("user-1");
    });
  });

  describe("findUpcoming()", () => {
    it("delegates to service.findUpcoming with userId and default days", async () => {
      const expected = [{ id: "st-1" }];
      mockService.findUpcoming.mockResolvedValue(expected);

      const result = await controller.findUpcoming(mockReq, 30);

      expect(result).toEqual(expected);
      expect(mockService.findUpcoming).toHaveBeenCalledWith("user-1", 30);
    });

    it("parses days query parameter", async () => {
      mockService.findUpcoming.mockResolvedValue([]);

      await controller.findUpcoming(mockReq, 7);

      expect(mockService.findUpcoming).toHaveBeenCalledWith("user-1", 7);
    });
  });

  describe("findOccurrences()", () => {
    it("passes the window through and defaults the per-schedule cap", async () => {
      const expected = [
        {
          scheduledTransactionId: "st-1",
          originalDate: "2026-09-01",
          dueDate: "2026-09-05",
          amount: -1650,
          amountComplete: true,
          currencyCode: "USD",
          overrideId: "ovr-1",
          moved: true,
          accountId: "acc-1",
          transferAccountId: null,
          isTransfer: false,
        },
      ];
      mockService.findEffectiveOccurrences.mockResolvedValue(expected);

      const result = await controller.findOccurrences(mockReq, {
        through: "2026-11-30",
      });

      expect(result).toEqual(expected);
      expect(mockService.findEffectiveOccurrences).toHaveBeenCalledWith(
        "user-1",
        { through: "2026-11-30", maxPerSchedule: undefined },
      );
    });

    it("forwards an explicit per-schedule cap", async () => {
      mockService.findEffectiveOccurrences.mockResolvedValue([]);

      await controller.findOccurrences(mockReq, {
        through: "2026-11-30",
        maxPerSchedule: 3,
      });

      expect(mockService.findEffectiveOccurrences).toHaveBeenCalledWith(
        "user-1",
        { through: "2026-11-30", maxPerSchedule: 3 },
      );
    });

    /**
     * The occurrence payload carries `accountId` / `transferAccountId` /
     * `isTransfer` precisely so the delegate filter can work on it, exactly as it
     * does on a schedule list.
     */
    it("hides an occurrence on an account the delegate cannot read", async () => {
      mockService.findEffectiveOccurrences.mockResolvedValue([
        {
          scheduledTransactionId: "st-1",
          accountId: "readable",
          isTransfer: false,
        },
        {
          scheduledTransactionId: "st-2",
          accountId: "hidden",
          isTransfer: false,
        },
      ]);
      delegationMock.readableAccountIds.mockResolvedValue(["readable"]);

      const result = (await controller.findOccurrences(
        { user: { id: "user-1", isActing: true, delegationId: "del-1" } },
        { through: "2026-11-30" },
      )) as { scheduledTransactionId: string }[];

      expect(result.map((r) => r.scheduledTransactionId)).toEqual(["st-1"]);
    });
  });

  describe("findOne()", () => {
    it("delegates to service.findOne with userId and id", async () => {
      const expected = { id: "st-1", payeeId: "p1" };
      mockService.findOne.mockResolvedValue(expected);

      const result = await controller.findOne(mockReq, "st-1");

      expect(result).toEqual(expected);
      expect(mockService.findOne).toHaveBeenCalledWith("user-1", "st-1");
    });
  });

  describe("update()", () => {
    it("delegates to service.update with userId, id, and dto", async () => {
      const dto = { amount: 200 };
      const expected = { id: "st-1", amount: 200 };
      mockService.update.mockResolvedValue(expected);

      const result = await controller.update(mockReq, "st-1", dto as any);

      expect(result).toEqual(expected);
      expect(mockService.update).toHaveBeenCalledWith("user-1", "st-1", dto);
    });
  });

  describe("remove()", () => {
    it("delegates to service.remove with userId and id", async () => {
      mockService.remove.mockResolvedValue(undefined);

      const result = await controller.remove(mockReq, "st-1");

      expect(result).toBeUndefined();
      expect(mockService.remove).toHaveBeenCalledWith("user-1", "st-1");
    });
  });

  describe("post()", () => {
    it("delegates to service.post with userId, id, and dto", async () => {
      const dto = { date: "2024-01-15" };
      const expected = { id: "tx-1", amount: 100 };
      mockService.post.mockResolvedValue(expected);

      const result = await controller.post(mockReq, "st-1", dto as any);

      expect(result).toEqual(expected);
      expect(mockService.post).toHaveBeenCalledWith("user-1", "st-1", dto, {
        actorIsNotOwner: false,
      });
    });

    it("tells the service the poster is not the owner when a delegate is acting", async () => {
      const dto = { date: "2024-01-15" };
      mockService.post.mockResolvedValue({ id: "tx-1" });

      await controller.post(
        {
          user: {
            id: "owner-1",
            realUserId: "delegate-1",
            isActing: true,
            delegationId: "d1",
          },
        },
        "st-1",
        dto as any,
      );

      expect(mockService.post).toHaveBeenCalledWith("owner-1", "st-1", dto, {
        actorIsNotOwner: true,
      });
    });
  });

  describe("getLoanProjectionAnchor()", () => {
    it("delegates to service.getLoanProjectionAnchor with userId and accountId", async () => {
      const expected = { nextDueDate: "2026-08-01", debt: 198500 };
      mockService.getLoanProjectionAnchor.mockResolvedValue(expected);

      const result = await controller.getLoanProjectionAnchor(
        mockReq,
        "acc-loan",
      );

      expect(result).toEqual(expected);
      expect(mockService.getLoanProjectionAnchor).toHaveBeenCalledWith(
        "user-1",
        "acc-loan",
      );
    });
  });

  describe("getLoanProjectionAnchor() joint fallback", () => {
    it("re-reads with the owner's scope for a jointly shared loan", async () => {
      // The report's account list is a union of owned and jointly shared
      // accounts. Under the caller's own scope a shared loan resolves to
      // nothing, and {null, null} means "no scheduled payment" -- which the
      // report reads as licence to project from today. Authorize, then read as
      // the owner, exactly as GET /accounts/:id/balance does.
      mockService.getLoanProjectionAnchor
        .mockResolvedValueOnce({ nextDueDate: null, debt: null })
        .mockResolvedValueOnce({ nextDueDate: "2026-08-01", debt: 198500 });
      jointMock.jointAccountIdSetFor.mockResolvedValue(new Set(["acc-loan"]));
      jointMock.jointAccessFor.mockResolvedValue({ ownerUserId: "owner-9" });

      const result = await controller.getLoanProjectionAnchor(
        mockReq,
        "acc-loan",
      );

      expect(result).toEqual({ nextDueDate: "2026-08-01", debt: 198500 });
      expect(mockService.getLoanProjectionAnchor).toHaveBeenLastCalledWith(
        "owner-9",
        "acc-loan",
      );
    });

    it("does not reach for the owner's scope on an account nobody shared", async () => {
      mockService.getLoanProjectionAnchor.mockResolvedValue({
        nextDueDate: null,
        debt: null,
      });
      jointMock.jointAccountIdSetFor.mockResolvedValue(new Set<string>());

      const result = await controller.getLoanProjectionAnchor(
        mockReq,
        "acc-loan",
      );

      expect(result).toEqual({ nextDueDate: null, debt: null });
      expect(jointMock.jointAccessFor).not.toHaveBeenCalled();
    });

    it("leaves an owned loan's answer alone", async () => {
      mockService.getLoanProjectionAnchor.mockResolvedValue({
        nextDueDate: "2026-08-01",
        debt: 198500,
      });

      await controller.getLoanProjectionAnchor(mockReq, "acc-loan");

      expect(jointMock.jointAccountIdSetFor).not.toHaveBeenCalled();
      expect(mockService.getLoanProjectionAnchor).toHaveBeenCalledTimes(1);
    });
  });

  describe("skip()", () => {
    it("delegates to service.skip with userId and id", async () => {
      const expected = { id: "st-1", nextDueDate: "2024-02-15" };
      mockService.skip.mockResolvedValue(expected);

      const result = await controller.skip(mockReq, "st-1");

      expect(result).toEqual(expected);
      expect(mockService.skip).toHaveBeenCalledWith("user-1", "st-1");
    });
  });

  describe("findOverrides()", () => {
    it("delegates to service.findOverrides with userId and id", async () => {
      const expected = [{ id: "ov-1", date: "2024-03-01" }];
      mockService.findOverrides.mockResolvedValue(expected);

      const result = await controller.findOverrides(mockReq, "st-1");

      expect(result).toEqual(expected);
      expect(mockService.findOverrides).toHaveBeenCalledWith("user-1", "st-1");
    });
  });

  describe("hasOverrides()", () => {
    it("delegates to service.hasOverrides with userId and id", async () => {
      mockService.hasOverrides.mockResolvedValue(true);

      const result = await controller.hasOverrides(mockReq, "st-1");

      expect(result).toBe(true);
      expect(mockService.hasOverrides).toHaveBeenCalledWith("user-1", "st-1");
    });
  });

  describe("findOverrideByDate()", () => {
    it("delegates to service.findOverrideByDate with userId, id, and date", async () => {
      const expected = { id: "ov-1", date: "2024-03-01", amount: 150 };
      mockService.findOverrideByDate.mockResolvedValue(expected);

      const result = await controller.findOverrideByDate(
        mockReq,
        "st-1",
        "2024-03-01",
      );

      expect(result).toEqual(expected);
      expect(mockService.findOverrideByDate).toHaveBeenCalledWith(
        "user-1",
        "st-1",
        "2024-03-01",
      );
    });

    it("rejects an invalid date format with 400 BadRequestException", () => {
      expect(() =>
        controller.findOverrideByDate(mockReq, "st-1", "03/01/2024"),
      ).toThrow(/YYYY-MM-DD/);
    });

    it("rejects an empty date string", () => {
      expect(() => controller.findOverrideByDate(mockReq, "st-1", "")).toThrow(
        /YYYY-MM-DD/,
      );
    });
  });

  describe("createOverride()", () => {
    it("delegates to service.createOverride with userId, id, and dto", async () => {
      const dto = { date: "2024-03-01", amount: 150 };
      const expected = { id: "ov-1", ...dto };
      mockService.createOverride.mockResolvedValue(expected);

      const result = await controller.createOverride(
        mockReq,
        "st-1",
        dto as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.createOverride).toHaveBeenCalledWith(
        "user-1",
        "st-1",
        dto,
      );
    });
  });

  describe("findOverride()", () => {
    it("delegates to service.findOverride with userId, id, and overrideId", async () => {
      const expected = { id: "ov-1", date: "2024-03-01" };
      mockService.findOverride.mockResolvedValue(expected);

      const result = await controller.findOverride(mockReq, "st-1", "ov-1");

      expect(result).toEqual(expected);
      expect(mockService.findOverride).toHaveBeenCalledWith(
        "user-1",
        "st-1",
        "ov-1",
      );
    });
  });

  describe("updateOverride()", () => {
    it("delegates to service.updateOverride with userId, id, overrideId, and dto", async () => {
      const dto = { amount: 200 };
      const expected = { id: "ov-1", amount: 200 };
      mockService.updateOverride.mockResolvedValue(expected);

      const result = await controller.updateOverride(
        mockReq,
        "st-1",
        "ov-1",
        dto as any,
      );

      expect(result).toEqual(expected);
      expect(mockService.updateOverride).toHaveBeenCalledWith(
        "user-1",
        "st-1",
        "ov-1",
        dto,
      );
    });
  });

  describe("removeOverride()", () => {
    it("delegates to service.removeOverride with userId, id, and overrideId", async () => {
      mockService.removeOverride.mockResolvedValue(undefined);

      const result = await controller.removeOverride(mockReq, "st-1", "ov-1");

      expect(result).toBeUndefined();
      expect(mockService.removeOverride).toHaveBeenCalledWith(
        "user-1",
        "st-1",
        "ov-1",
      );
    });
  });

  describe("removeAllOverrides()", () => {
    it("delegates to service.removeAllOverrides with userId and id", async () => {
      mockService.removeAllOverrides.mockResolvedValue(undefined);

      const result = await controller.removeAllOverrides(mockReq, "st-1");

      expect(result).toBeUndefined();
      expect(mockService.removeAllOverrides).toHaveBeenCalledWith(
        "user-1",
        "st-1",
      );
    });
  });
});
