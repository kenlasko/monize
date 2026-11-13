import { ConflictException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { ActionHistoryService } from "./action-history.service";
import { ActionHistory } from "./entities/action-history.entity";
import { repriceSettledLoanTemplates } from "../loan-installments/reprice-template";
import {
  ScheduledPostingMoneyRemover,
  undoScheduledPosting,
} from "./scheduled-posting-undo";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
jest.mock("./scheduled-posting-undo", () => ({
  ...jest.requireActual("./scheduled-posting-undo"),
  undoScheduledPosting: jest.fn(),
}));
jest.mock("../loan-installments/reprice-template", () => ({
  repriceSettledLoanTemplates: jest.fn().mockResolvedValue(undefined),
}));

/**
 * A posted scheduled occurrence is one entry (issue #2165); undo routes it to
 * `undoScheduledPosting`, whose rows are removed by the undo of the create
 * that wrote them, and redo refuses.
 */
describe("ActionHistoryService: scheduled posting entries", () => {
  const userId = "user-1";
  let service: ActionHistoryService;
  let repo: Record<string, jest.Mock>;
  let manager: Record<string, jest.Mock>;

  const entry = {
    id: "h1",
    userId,
    entityType: "scheduled_posting",
    entityId: "st-1",
    action: "post",
    beforeData: null,
    afterData: {
      scheduledTransactionId: "st-1",
      claimId: "claim-1",
      dueDate: "2025-01-15",
      money: { kind: "transaction", transactionId: "tx-1" },
    },
    isUndone: false,
    description: 'Posted scheduled transaction "Gym"',
  } as unknown as ActionHistory;

  beforeEach(async () => {
    jest.clearAllMocks();
    (undoScheduledPosting as jest.Mock).mockResolvedValue({
      scheduleIds: ["st-1"],
      securityIds: [],
    });
    repo = { findOne: jest.fn() };
    const scoped = createScopedDbMocks([[ActionHistory, repo]]);
    manager = scoped.manager;
    manager.update.mockResolvedValue({ affected: 1 });
    const module = await Test.createTestingModule({
      providers: [
        ActionHistoryService,
        { provide: DataSource, useValue: scoped.dataSource },
      ],
    }).compile();
    service = module.get(ActionHistoryService);
  });

  it("undo hands the entry to undoScheduledPosting, marks it undone and reprices the schedule after", async () => {
    repo.findOne.mockResolvedValue(entry);

    const result = await service.undo(userId);

    expect(undoScheduledPosting).toHaveBeenCalledWith(
      entry,
      manager,
      expect.any(Function),
    );
    expect(manager.update).toHaveBeenCalledWith(ActionHistory, "h1", {
      isUndone: true,
    });
    expect(repriceSettledLoanTemplates).toHaveBeenCalledWith(
      expect.anything(),
      ["st-1"],
    );
    expect(result.description).toContain("Undone");
  });

  describe("the rows are removed by the undo of the create that wrote them", () => {
    let remover: ScheduledPostingMoneyRemover;
    let undoTransactionCreate: jest.SpyInstance;
    let undoTransferCreate: jest.SpyInstance;
    let undoInvestmentCreate: jest.SpyInstance;

    beforeEach(async () => {
      (undoScheduledPosting as jest.Mock).mockImplementation(
        async (_action, _m, remove: ScheduledPostingMoneyRemover) => {
          remover = remove;
          return { scheduleIds: [], securityIds: [] };
        },
      );
      undoTransactionCreate = jest
        .spyOn(service as any, "undoTransactionCreate")
        .mockResolvedValue(undefined);
      undoTransferCreate = jest
        .spyOn(service as any, "undoTransferCreate")
        .mockResolvedValue(undefined);
      undoInvestmentCreate = jest
        .spyOn(service as any, "undoInvestmentCreate")
        .mockResolvedValue(undefined);
      repo.findOne.mockResolvedValue(entry);
      await service.undo(userId);
    });

    it("a transaction", async () => {
      await remover({ kind: "transaction", transactionId: "tx-1" });
      expect(undoTransactionCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId, entityId: "tx-1" }),
        manager,
      );
    });

    it("a transfer's two legs", async () => {
      const legs = {
        fromTransactionId: "tx-1",
        toTransactionId: "tx-2",
        fromAccountId: "acc-1",
        toAccountId: "acc-2",
      };
      await remover({ kind: "transfer", ...legs });
      expect(undoTransferCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId, afterData: legs }),
        manager,
      );
    });

    it("an investment transaction", async () => {
      await remover({
        kind: "investment",
        investmentTransactionId: "inv-1",
        securityId: "sec-1",
      });
      expect(undoInvestmentCreate).toHaveBeenCalledWith(
        expect.objectContaining({ userId, entityId: "inv-1" }),
        manager,
      );
    });
  });

  it("redo refuses before anything is written", async () => {
    repo.findOne.mockResolvedValue({ ...entry, isUndone: true });

    await expect(service.redo(userId)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(undoScheduledPosting).not.toHaveBeenCalled();
    expect(manager.update).not.toHaveBeenCalled();
  });
});
