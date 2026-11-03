import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Category } from "../categories/entities/category.entity";
import * as priceInstallment from "../loan-installments/price-installment";
import { ScheduledTransactionSplit } from "../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { SplitKind } from "../transactions/entities/split-kind.enum";
import { LoanFee } from "../loan-fees/entities/loan-fee.entity";
import {
  applyLoanInterestRelink,
  assertLoanInterestCategory,
  planLoanInterestRelink,
} from "./loan-interest-category";

const USER = "user-1";
const LOAN = "loan-1";
const SCHEDULE = "sched-1";
const A = "cat-a";
const B = "cat-b";
const ESCROW = "cat-escrow";

const principal = (): ScheduledTransactionSplit =>
  ({
    id: "s-principal",
    kind: SplitKind.TRANSFER,
    transferAccountId: LOAN,
    categoryId: null,
    amount: -800,
    memo: "Principal",
  }) as ScheduledTransactionSplit;

const categoryLine = (
  id: string,
  categoryId: string | null,
  memo: string,
): ScheduledTransactionSplit =>
  ({
    id,
    kind: SplitKind.CATEGORY,
    transferAccountId: null,
    categoryId,
    amount: -200,
    memo,
  }) as ScheduledTransactionSplit;

describe("loan interest category", () => {
  let categories: Record<string, jest.Mock>;
  let schedules: Record<string, jest.Mock>;
  let splitsRepo: Record<string, jest.Mock>;
  let loanFees: Record<string, jest.Mock>;
  let m: EntityManager;
  const loan = { id: LOAN, scheduledTransactionId: SCHEDULE };

  const withSplits = (splits: ScheduledTransactionSplit[]) =>
    splitsRepo.find.mockResolvedValue(splits);

  beforeEach(() => {
    jest.restoreAllMocks();
    categories = { findOne: jest.fn() };
    schedules = {
      findOne: jest.fn().mockResolvedValue({ id: SCHEDULE, userId: USER }),
    };
    splitsRepo = {
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn().mockImplementation((s) => Promise.resolve(s)),
    };
    loanFees = { find: jest.fn().mockResolvedValue([]) };
    const mocks = createScopedDbMocks([
      [LoanFee, loanFees],
      [Category, categories],
      [ScheduledTransaction, schedules],
      [ScheduledTransactionSplit, splitsRepo],
    ]);
    m = mocks.manager as unknown as EntityManager;
  });

  describe("assertLoanInterestCategory", () => {
    it("accepts a category the caller owns", async () => {
      categories.findOne.mockResolvedValue({ id: B, userId: USER });
      await expect(
        assertLoanInterestCategory(m, USER, B),
      ).resolves.toBeUndefined();
      expect(categories.findOne).toHaveBeenCalledWith({
        where: { id: B, userId: USER },
      });
    });

    it("refuses a category that is unknown or another user's", async () => {
      categories.findOne.mockResolvedValue(null);
      await expect(assertLoanInterestCategory(m, USER, B)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe("planLoanInterestRelink", () => {
    it("refuses a category one of the mortgage's fees holds, before reading the schedule", async () => {
      loanFees.find.mockResolvedValue([{ categoryId: B }]);

      await expect(planLoanInterestRelink(m, USER, loan, A, B)).rejects.toThrow(
        BadRequestException,
      );
      expect(schedules.findOne).not.toHaveBeenCalled();
    });

    it("keeps a template with a fee line managed across the change (INV-LOAN-011)", async () => {
      const interest = categoryLine("s-interest", A, "Interest");
      const tax = categoryLine("s-tax", ESCROW, "Property tax");
      loanFees.find.mockResolvedValue([
        {
          categoryId: ESCROW,
          name: "Property tax",
          calculation: "FIXED",
          basis: "ANNUAL",
          amount: 2400,
          rate: null,
        },
      ]);
      withSplits([principal(), interest, tax]);

      const plan = await planLoanInterestRelink(m, USER, loan, A, B);

      expect(plan).toEqual({ kind: "relink", split: interest, next: B });
    });

    it("relinks an uncategorised interest line once a category is set", async () => {
      const interest = categoryLine("s-interest", null, "Interest");
      withSplits([principal(), interest]);

      const plan = await planLoanInterestRelink(m, USER, loan, null, B);

      expect(plan).toEqual({ kind: "relink", split: interest, next: B });
      expect(schedules.findOne).toHaveBeenCalledWith({
        where: { id: SCHEDULE, userId: USER },
        lock: { mode: "pessimistic_write" },
      });
      expect(splitsRepo.save).not.toHaveBeenCalled();
    });

    it("relinks a managed template's interest line from A to B", async () => {
      const interest = categoryLine("s-interest", A, "Interest");
      withSplits([principal(), interest]);

      const plan = await planLoanInterestRelink(m, USER, loan, A, B);

      expect(plan).toEqual({ kind: "relink", split: interest, next: B });
    });

    it("relinks the single categorised line a template with no previous category already manages", async () => {
      // Managed with no configured category: the one categorised line is
      // interest, whatever category it carries.
      const interest = categoryLine("s-interest", "cat-other", "Interest");
      withSplits([principal(), interest]);

      const plan = await planLoanInterestRelink(m, USER, loan, null, B);

      expect(plan).toEqual({ kind: "relink", split: interest, next: B });
    });

    it("does nothing when the category is cleared", async () => {
      const plan = await planLoanInterestRelink(m, USER, loan, A, null);

      expect(plan.kind).toBe("noop");
      expect(schedules.findOne).not.toHaveBeenCalled();
      expect(splitsRepo.find).not.toHaveBeenCalled();
    });

    it("does nothing for a loan with no linked schedule", async () => {
      const plan = await planLoanInterestRelink(
        m,
        USER,
        { id: LOAN, scheduledTransactionId: null },
        A,
        B,
      );

      expect(plan.kind).toBe("noop");
      expect(schedules.findOne).not.toHaveBeenCalled();
    });

    it("does nothing when the schedule is not the caller's", async () => {
      schedules.findOne.mockResolvedValue(null);

      const plan = await planLoanInterestRelink(m, USER, loan, A, B);

      expect(plan.kind).toBe("noop");
      expect(splitsRepo.find).not.toHaveBeenCalled();
    });

    it("leaves an uncategorised interest and escrow pair alone: two candidates", async () => {
      const interest = categoryLine("s-interest", null, "Interest");
      const escrow = categoryLine("s-escrow", null, "Escrow");
      withSplits([principal(), interest, escrow]);

      const plan = await planLoanInterestRelink(m, USER, loan, null, B);

      expect(plan).toEqual({ kind: "noop", reason: "2 candidate lines" });
      expect(interest.categoryId).toBeNull();
      expect(escrow.categoryId).toBeNull();
    });

    it("leaves an uncategorised interest line beside a categorised escrow alone: the result is unmanaged", async () => {
      const interest = categoryLine("s-interest", null, "Interest");
      const escrow = categoryLine("s-escrow", ESCROW, "Escrow");
      withSplits([principal(), interest, escrow]);

      const plan = await planLoanInterestRelink(m, USER, loan, null, B);

      expect(plan).toEqual({
        kind: "noop",
        reason: "template not managed even with the line relinked",
      });
      expect(interest.categoryId).toBeNull();
      expect(escrow.categoryId).toBe(ESCROW);
    });

    it("leaves interest A beside an uncategorised escrow alone on A -> B: two candidates, unmanaged before", async () => {
      const interest = categoryLine("s-interest", A, "Interest");
      const escrow = categoryLine("s-escrow", null, "Escrow");
      withSplits([principal(), interest, escrow]);

      const plan = await planLoanInterestRelink(m, USER, loan, A, B);

      expect(plan).toEqual({ kind: "noop", reason: "2 candidate lines" });
      expect(interest.categoryId).toBe(A);
      expect(escrow.categoryId).toBeNull();
    });

    it("refuses a change that would leave a managed template unmanaged, before writing", async () => {
      // Unreachable with the real identification (a managed template's
      // interest line is always the single candidate), so the second call --
      // the relinked template -- is forced unmanaged to exercise the refusal.
      const interest = categoryLine("s-interest", A, "Interest");
      withSplits([principal(), interest]);
      const real = priceInstallment.identifyLoanTemplate;
      jest
        .spyOn(priceInstallment, "identifyLoanTemplate")
        .mockImplementationOnce(real)
        .mockImplementationOnce(
          (splits, account) =>
            ({
              ...real(splits, account),
              managed: false,
              categoryLines: [],
            }) as ReturnType<typeof real>,
        );

      await expect(planLoanInterestRelink(m, USER, loan, A, B)).rejects.toThrow(
        BadRequestException,
      );
      expect(splitsRepo.save).not.toHaveBeenCalled();
      expect(interest.categoryId).toBe(A);
    });
  });

  describe("applyLoanInterestRelink", () => {
    it("writes only the line's category", async () => {
      const interest = categoryLine("s-interest", A, "Interest");

      await applyLoanInterestRelink(m, {
        kind: "relink",
        split: interest,
        next: B,
      });

      expect(splitsRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "s-interest",
          categoryId: B,
          amount: -200,
        }),
      );
    });

    it("writes nothing for a no-op", async () => {
      await applyLoanInterestRelink(m, { kind: "noop", reason: "x" });
      expect(splitsRepo.save).not.toHaveBeenCalled();
    });
  });
});
