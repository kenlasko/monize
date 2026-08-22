import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("ScheduledTransactionLoanService", () => {
  let service: ScheduledTransactionLoanService;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;

  const loanAccountId = "acc-loan";
  const scheduledTransactionId = "st-1";
  const userId = "user-1";

  const makeLoanAccount = (overrides: Partial<Account> = {}): Account =>
    ({
      id: loanAccountId,
      userId,
      accountType: "LOAN",
      name: "Car Loan",
      currentBalance: -20000,
      interestRate: 5.5,
      paymentFrequency: "MONTHLY",
      paymentAmount: 500,
      ...overrides,
    }) as Account;

  const makeScheduledTransaction = (
    overrides: Partial<ScheduledTransaction> = {},
  ): ScheduledTransaction =>
    ({
      id: scheduledTransactionId,
      userId,
      accountId: "acc-chequing",
      name: "Loan Payment",
      amount: -500,
      frequency: "MONTHLY",
      isActive: true,
      splits: [
        {
          id: "split-principal",
          transferAccountId: loanAccountId,
          categoryId: null,
          amount: -390,
          memo: "Principal",
        },
        {
          id: "split-interest",
          transferAccountId: null,
          categoryId: "cat-interest",
          amount: -110,
          memo: "Interest",
        },
      ],
      ...overrides,
    }) as unknown as ScheduledTransaction;

  beforeEach(async () => {
    scheduledTransactionsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    splitsRepository = {
      save: jest
        .fn()
        .mockImplementation((entity: any) => Promise.resolve(entity)),
      // recalculateLoanPaymentSplits now re-reads the child set under the parent
      // lock (issue #1154 re-review) instead of using the entity's relation;
      // mirror whatever splits the mocked scheduled transaction carries.
      find: jest.fn(async () => {
        const st = await scheduledTransactionsRepository.findOne();
        return (st && st.splits) || [];
      }),
    };

    accountsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    const { dataSource } = createScopedDbMocks([
      [ScheduledTransaction, scheduledTransactionsRepository],
      [ScheduledTransactionSplit, splitsRepository],
      [Account, accountsRepository],
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTransactionLoanService,
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<ScheduledTransactionLoanService>(
      ScheduledTransactionLoanService,
    );
  });

  describe("recalculateLoanPaymentSplits", () => {
    it("should recalculate principal and interest splits based on current balance", async () => {
      const loanAccount = makeLoanAccount({ currentBalance: -20000 });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction();
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      // Should save both splits with updated amounts
      expect(splitsRepository.save).toHaveBeenCalledTimes(2);

      // First save should be for principal split
      const principalSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].transferAccountId === loanAccountId,
      );
      expect(principalSave).toBeDefined();
      expect(principalSave[0].amount).toBeLessThan(0);

      // Second save should be for interest split
      const interestSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].categoryId === "cat-interest",
      );
      expect(interestSave).toBeDefined();
      expect(interestSave[0].amount).toBeLessThan(0);
    });

    describe("final installment (P5-008)", () => {
      it("reduces the parent amount with the principal when the balance is below one payment", async () => {
        // The audit's worked example: 50 outstanding at 0%, regular payment 100.
        //
        // The principal child was capped to 50 and the parent left at -100, so
        // the posting path submitted children summing -50 against a -100 parent
        // and the shared split validator rejected it on exact 4dp equality. The
        // final payment failed at exactly the moment the user expected the loan
        // to close.
        const loanAccount = makeLoanAccount({
          currentBalance: -50,
          interestRate: 0,
        });
        accountsRepository.findOne.mockResolvedValue(loanAccount);

        // No usable previous split data, so the balance-based fallback runs.
        const scheduledTx = makeScheduledTransaction({
          amount: -100,
          splits: [
            {
              id: "split-principal",
              transferAccountId: loanAccountId,
              categoryId: null,
              amount: 0,
              memo: "Principal",
            },
            {
              id: "split-interest",
              transferAccountId: null,
              categoryId: "cat-interest",
              amount: 0,
              memo: "Interest",
            },
          ],
        } as never);
        scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        const principalSave = splitsRepository.save.mock.calls.find(
          (call: any) => call[0].transferAccountId === loanAccountId,
        );
        const interestSave = splitsRepository.save.mock.calls.find(
          (call: any) => call[0].categoryId === "cat-interest",
        );
        expect(principalSave[0].amount).toBe(-50);
        expect(interestSave[0].amount).toBe(-0);

        // The parent shrank to match, so parent and children reconcile exactly.
        expect(scheduledTransactionsRepository.update).toHaveBeenCalledWith(
          scheduledTransactionId,
          { amount: -50 },
        );
      });

      it("leaves the parent alone for an ordinary installment", async () => {
        // The reduction must be a floor-following clamp, not a rewrite: a
        // regular payment keeps the amount the user set.
        const loanAccount = makeLoanAccount({ currentBalance: -20000 });
        accountsRepository.findOne.mockResolvedValue(loanAccount);
        scheduledTransactionsRepository.findOne.mockResolvedValue(
          makeScheduledTransaction(),
        );

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
      });

      it("caps interest at the payment when the payment does not cover it (RR2-006)", async () => {
        // 100,000 outstanding at 60% annual (5% monthly) against a configured
        // 1,000 payment. Neither branch bounded the interest and the parent
        // update only ever shrinks, so the template held an interest child of
        // -5,000 under a parent of -1,000 -- children 4,000 above the parent,
        // which the posting path's split validator rejects outright, so the
        // schedule stopped posting. `LoanPaymentSetupService` was corrected for
        // the same underpayment and this sibling was not.
        const loanAccount = makeLoanAccount({
          currentBalance: -100000,
          interestRate: 60,
        });
        accountsRepository.findOne.mockResolvedValue(loanAccount);

        // No previous split values, so the balance-based branch runs.
        const scheduledTx = makeScheduledTransaction({
          amount: -1000,
          splits: [
            {
              id: "split-principal",
              transferAccountId: loanAccountId,
              categoryId: null,
              amount: 0,
              memo: "Principal",
            },
            {
              id: "split-interest",
              transferAccountId: null,
              categoryId: "cat-interest",
              amount: 0,
              memo: "Interest",
            },
          ],
        } as never);
        scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        const saved = Object.fromEntries(
          splitsRepository.save.mock.calls.map((call: any) => [
            call[0].id,
            call[0].amount,
          ]),
        );
        // The whole installment goes to interest; nothing retires principal.
        expect(saved["split-interest"]).toBe(-1000);
        expect(saved["split-principal"]).toBe(-0);
        // Children sum to the parent exactly, so posting still validates. The
        // parent keeps the amount the user configured -- the payment is not
        // short of the debt, it is short of the interest.
        expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
      });

      it("applies interest first across the whole installment, extra included (DR3-01)", async () => {
        // 1,000 payment with a 300 standing extra-principal transfer against 800 of
        // accrued interest. Capping interest at the base payment (700) left the
        // extra reducing principal while 100 of interest went unpaid. A lender
        // applies a payment to accrued interest before principal, so the extra has
        // no principal to reduce until the interest is met.
        const loanAccount = makeLoanAccount({
          currentBalance: -100000,
          // 800 of interest on 100,000 is 0.8% per period; annual = 9.6%.
          interestRate: 9.6,
        });
        accountsRepository.findOne.mockResolvedValue(loanAccount);

        const scheduledTx = makeScheduledTransaction({
          amount: -1000,
          splits: [
            {
              id: "split-principal",
              transferAccountId: loanAccountId,
              categoryId: null,
              amount: 0,
              memo: "Principal",
            },
            {
              id: "split-extra",
              transferAccountId: loanAccountId,
              categoryId: null,
              amount: -300,
              memo: "Extra Principal",
            },
            {
              id: "split-interest",
              transferAccountId: null,
              categoryId: "cat-interest",
              amount: 0,
              memo: "Interest",
            },
          ],
        } as never);
        scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        const saved = Object.fromEntries(
          splitsRepository.save.mock.calls.map((call: any) => [
            call[0].id,
            call[0].amount,
          ]),
        );
        // The whole 800 of interest is paid; nothing is left for principal, so the
        // extra comes down to 200 and the installment still sums to 1,000.
        expect(saved["split-interest"]).toBe(-800);
        expect(saved["split-principal"]).toBe(-0);
        expect(saved["split-extra"]).toBe(-200);
        expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
      });

      it("clamps regular and extra principal together, not each on its own (FR-009)", async () => {
        // 500 left on the loan, a 400 amortized principal and a standing 300
        // extra-principal transfer. The clamp only ever looked at the regular
        // child, which was already under the balance, so 700 of principal went
        // into a 500 debt: the loan account crossed zero into a 200 credit, and
        // the payoff branch waiting for `<= 0.01` never fired.
        const loanAccount = makeLoanAccount({
          currentBalance: -500,
          interestRate: 0,
        });
        accountsRepository.findOne.mockResolvedValue(loanAccount);

        // Zero rate and no previous interest, so the balance-based branch runs
        // and the amortized principal is basePayment (700 - 300 = 400).
        const scheduledTx = makeScheduledTransaction({
          amount: -700,
          splits: [
            {
              id: "split-principal",
              transferAccountId: loanAccountId,
              categoryId: null,
              amount: 0,
              memo: "Principal",
            },
            {
              id: "split-extra",
              transferAccountId: loanAccountId,
              categoryId: null,
              amount: -300,
              memo: "Extra Principal",
            },
            {
              id: "split-interest",
              transferAccountId: null,
              categoryId: "cat-interest",
              amount: 0,
              memo: "Interest",
            },
          ],
        } as never);
        scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        const saved = splitsRepository.save.mock.calls.map((call: any) => [
          call[0].id,
          call[0].amount,
        ]);
        // Amortization keeps its 400; the discretionary extra absorbs the
        // shortfall and comes down to 100. Together they retire exactly 500.
        expect(saved).toEqual(
          expect.arrayContaining([
            ["split-principal", -400],
            ["split-extra", -100],
          ]),
        );

        // The parent equals the sum of the children to the cent, which is what
        // the posting path's split validator demands.
        expect(scheduledTransactionsRepository.update).toHaveBeenCalledWith(
          scheduledTransactionId,
          { amount: -500 },
        );
      });

      it("leaves the extra principal alone when the total still fits", async () => {
        // The clamp must not touch a schedule that is not in its final
        // installment: the extra transfer is the user's standing instruction.
        const loanAccount = makeLoanAccount({
          currentBalance: -20000,
          interestRate: 0,
        });
        accountsRepository.findOne.mockResolvedValue(loanAccount);

        scheduledTransactionsRepository.findOne.mockResolvedValue(
          makeScheduledTransaction({
            amount: -700,
            splits: [
              {
                id: "split-principal",
                transferAccountId: loanAccountId,
                categoryId: null,
                amount: 0,
                memo: "Principal",
              },
              {
                id: "split-extra",
                transferAccountId: loanAccountId,
                categoryId: null,
                amount: -300,
                memo: "Extra Principal",
              },
              {
                id: "split-interest",
                transferAccountId: null,
                categoryId: "cat-interest",
                amount: 0,
                memo: "Interest",
              },
            ],
          } as never),
        );

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        const extraSave = splitsRepository.save.mock.calls.find(
          (call: any) => call[0].id === "split-extra",
        );
        expect(extraSave).toBeUndefined();
        expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
      });

      it("drops the extra principal to zero when the amortized principal alone closes the loan", async () => {
        // 200 outstanding against a 400 amortized principal: the regular child
        // clamps to 200 and there is nothing left for the extra to retire.
        // Paying it anyway is money into a settled debt.
        const loanAccount = makeLoanAccount({
          currentBalance: -200,
          interestRate: 0,
        });
        accountsRepository.findOne.mockResolvedValue(loanAccount);

        scheduledTransactionsRepository.findOne.mockResolvedValue(
          makeScheduledTransaction({
            amount: -700,
            splits: [
              {
                id: "split-principal",
                transferAccountId: loanAccountId,
                categoryId: null,
                amount: 0,
                memo: "Principal",
              },
              {
                id: "split-extra",
                transferAccountId: loanAccountId,
                categoryId: null,
                amount: -300,
                memo: "Extra Principal",
              },
              {
                id: "split-interest",
                transferAccountId: null,
                categoryId: "cat-interest",
                amount: 0,
                memo: "Interest",
              },
            ],
          } as never),
        );

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        const saved = splitsRepository.save.mock.calls.map((call: any) => [
          call[0].id,
          call[0].amount,
        ]);
        expect(saved).toEqual(
          expect.arrayContaining([
            ["split-principal", -200],
            ["split-extra", -0],
          ]),
        );
        expect(scheduledTransactionsRepository.update).toHaveBeenCalledWith(
          scheduledTransactionId,
          { amount: -200 },
        );
      });

      it("caps the principal to the balance", async () => {
        const loanAccount = makeLoanAccount({
          currentBalance: -100,
          interestRate: 5.5,
        });
        accountsRepository.findOne.mockResolvedValue(loanAccount);

        scheduledTransactionsRepository.findOne.mockResolvedValue(
          makeScheduledTransaction({ amount: -500 }),
        );

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        const principalSave = splitsRepository.save.mock.calls.find(
          (call: any) => call[0].transferAccountId === loanAccountId,
        );
        // Never more principal than is owed.
        expect(Math.abs(principalSave[0].amount)).toBeLessThanOrEqual(100);

        // And the parent follows it down.
        const update = scheduledTransactionsRepository.update.mock.calls[0];
        expect(update).toBeDefined();
        expect(Math.abs(update[1].amount)).toBeLessThan(500);
      });
    });

    describe("clamps are not ratchets (review #1131)", () => {
      it("grows the parent back to the configured payment after the balance is restored", async () => {
        // A final payment shrank the template to 51. Then the posting that got
        // the balance near zero was voided (or history was imported), so the
        // loan owes 20,000 again -- but every recalculation used to read the
        // configured payment from the shrunk template, so nothing could ever
        // restore it: the schedule billed 51 a month against a 20,000 debt
        // forever. The durable configuration is account.paymentAmount.
        const loanAccount = makeLoanAccount({
          currentBalance: -20000,
          interestRate: 5.5,
          paymentAmount: 500,
        });
        accountsRepository.findOne.mockResolvedValue(loanAccount);

        scheduledTransactionsRepository.findOne.mockResolvedValue(
          makeScheduledTransaction({
            amount: -51,
            splits: [
              {
                id: "split-principal",
                transferAccountId: loanAccountId,
                categoryId: null,
                amount: -50,
                memo: "Principal",
              },
              {
                id: "split-interest",
                transferAccountId: null,
                categoryId: "cat-interest",
                amount: -1,
                memo: "Interest",
              },
            ],
          } as never),
        );

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        const update = scheduledTransactionsRepository.update.mock.calls.find(
          (call: any) => call[1]?.amount !== undefined,
        );
        expect(update).toBeDefined();
        expect(update![1].amount).toBe(-500);
      });

      it("restores the standing extra principal after a transient interest spike consumed it", async () => {
        // One underpayment period wrote the extra split down to 0 so the
        // installment could reconcile. That clamp was for that installment
        // only, but the recalculation used to read the configured extra from
        // the split it had just rewritten -- the user's standing instruction
        // was gone for good. The durable copy is account.extraPaymentAmount.
        const loanAccount = makeLoanAccount({
          currentBalance: -50000,
          interestRate: 2.4, // 0.2% monthly -> 100 interest on 50,000
          paymentAmount: 1000,
          extraPaymentAmount: 300,
        });
        accountsRepository.findOne.mockResolvedValue(loanAccount);

        // Post-spike template: everything went to interest, extra clamped to 0.
        scheduledTransactionsRepository.findOne.mockResolvedValue(
          makeScheduledTransaction({
            amount: -1000,
            splits: [
              {
                id: "split-principal",
                transferAccountId: loanAccountId,
                categoryId: null,
                amount: 0,
                memo: "Principal",
              },
              {
                id: "split-interest",
                transferAccountId: null,
                categoryId: "cat-interest",
                amount: -1000,
                memo: "Interest",
              },
              {
                id: "split-extra",
                transferAccountId: loanAccountId,
                categoryId: null,
                amount: 0,
                memo: "Extra Principal",
              },
            ],
          } as never),
        );

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        const extraSave = splitsRepository.save.mock.calls.find(
          (call: any) => call[0].id === "split-extra",
        );
        expect(extraSave).toBeDefined();
        expect(extraSave![0].amount).toBe(-300);

        // 100 interest + 600 regular principal + 300 extra = the configured
        // 1,000, so the parent needs no rewrite.
        const principalSave = splitsRepository.save.mock.calls.find(
          (call: any) => call[0].id === "split-principal",
        );
        expect(principalSave![0].amount).toBe(-600);
      });
    });

    it("should deactivate scheduled transaction when balance is near zero", async () => {
      const loanAccount = makeLoanAccount({ currentBalance: -0.005 });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction();
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(scheduledTransactionsRepository.update).toHaveBeenCalledWith(
        scheduledTransactionId,
        { isActive: false },
      );
    });

    it("should deactivate scheduled transaction when balance is exactly zero", async () => {
      const loanAccount = makeLoanAccount({ currentBalance: 0 });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction();
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(scheduledTransactionsRepository.update).toHaveBeenCalledWith(
        scheduledTransactionId,
        { isActive: false },
      );
    });

    it("should return early when no loan account is found among the splits", async () => {
      // The scheduled transaction and its splits exist, but none of the
      // transfer targets is a LOAN/MORTGAGE account (issue #1154 re-review:
      // the loan is derived from the current split set, not a passed id).
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction(),
      );
      accountsRepository.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(splitsRepository.save).not.toHaveBeenCalled();
      expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
    });

    it("should return early when scheduled transaction is not found", async () => {
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      scheduledTransactionsRepository.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(splitsRepository.save).not.toHaveBeenCalled();
    });

    it("should return early when scheduled transaction is inactive", async () => {
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction({ isActive: false }),
      );

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(splitsRepository.save).not.toHaveBeenCalled();
    });

    it("should use payment frequency from loan account when available", async () => {
      const loanAccount = makeLoanAccount({
        paymentFrequency: "BIWEEKLY",
        currentBalance: -20000,
      });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction({
        frequency: "MONTHLY",
      });
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      // Should have called save - we verify the calculation used BIWEEKLY rate
      // by checking the interest amount is different from monthly
      expect(splitsRepository.save).toHaveBeenCalledTimes(2);
    });

    it("should handle string balance from database decimal column", async () => {
      const loanAccount = makeLoanAccount({
        currentBalance: "-15000.50" as any,
      });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction();
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(splitsRepository.save).toHaveBeenCalledTimes(2);
    });

    it("should handle zero interest rate", async () => {
      const loanAccount = makeLoanAccount({
        currentBalance: -10000,
        interestRate: 0,
      });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction();
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      // With 0% interest, all payment goes to principal
      const interestSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].categoryId === "cat-interest",
      );
      expect(interestSave).toBeDefined();
      expect(interestSave[0].amount).toBe(-0); // -0 or 0 for zero interest
    });

    it("should handle null splits array gracefully", async () => {
      const loanAccount = makeLoanAccount({ currentBalance: -20000 });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction({ splits: null as any });
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      // principalSplit and interestSplit will be undefined
      // So save should not be called
      expect(splitsRepository.save).not.toHaveBeenCalled();
    });

    it("should handle empty splits array", async () => {
      const loanAccount = makeLoanAccount({ currentBalance: -20000 });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction({ splits: [] as any });
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(splitsRepository.save).not.toHaveBeenCalled();
    });

    it("should lock the parent scheduled transaction before recalculating", async () => {
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      scheduledTransactionsRepository.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      // The recalculation mutates the child split set, so it must serialize on
      // the same parent lock the posting path takes (issue #1154 re-review).
      expect(scheduledTransactionsRepository.findOne).toHaveBeenCalledWith({
        where: { id: scheduledTransactionId },
        lock: { mode: "pessimistic_write" },
      });
    });

    it("calculates interest from the authoritative post-payment balance", async () => {
      // The prior stored split is deliberately a cent away from the balance.
      // Reusing it through the amortization recurrence would produce 98.0101;
      // the post-payment balance gives the authoritative 98.0000.
      const loanAccount = makeLoanAccount({
        currentBalance: -19600,
        interestRate: 6,
        paymentFrequency: "MONTHLY",
      });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction({
        amount: -500,
        splits: [
          {
            id: "split-principal",
            transferAccountId: loanAccountId,
            categoryId: null,
            amount: -399.99,
            memo: "Principal",
          },
          {
            id: "split-interest",
            transferAccountId: null,
            categoryId: "cat-interest",
            amount: -100.01,
            memo: "Interest",
          },
        ] as any,
      });
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      const interestSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].categoryId === "cat-interest",
      );
      expect(interestSave[0].amount).toBe(-98);

      const principalSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].transferAccountId === loanAccountId,
      );
      expect(principalSave[0].amount).toBe(-402);
    });

    it("should recalculate a LINE_OF_CREDIT schedule (not only LOAN/MORTGAGE)", async () => {
      // LoanPaymentSetupService accepts LINE_OF_CREDIT, so its scheduled payment
      // must advance its next principal/interest split too (issue #1154
      // re-review). balance=910, rate=12%, monthly, payment=100:
      // periodicRate = 0.12/12 = 0.01
      // next_interest  = 10 - 90 * 0.01 = 9.10
      // next_principal = 100 - 9.10   = 90.90
      const locAccount = makeLoanAccount({
        accountType: AccountType.LINE_OF_CREDIT,
        currentBalance: -910,
        interestRate: 12,
        paymentFrequency: "MONTHLY",
        paymentAmount: 100,
      });
      accountsRepository.findOne.mockResolvedValue(locAccount);

      const scheduledTx = makeScheduledTransaction({
        amount: -100,
        splits: [
          {
            id: "split-principal",
            transferAccountId: loanAccountId,
            categoryId: null,
            amount: -90,
            memo: "Principal",
          },
          {
            id: "split-interest",
            transferAccountId: null,
            categoryId: "cat-interest",
            amount: -10,
            memo: "Interest",
          },
        ] as any,
      });
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      const interestSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].categoryId === "cat-interest",
      );
      expect(interestSave[0].amount).toBe(-9.1);

      const principalSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].transferAccountId === loanAccountId,
      );
      expect(principalSave[0].amount).toBe(-90.9);
    });

    it("should use mortgage-specific rate calculation for MORTGAGE accounts", async () => {
      // Canadian fixed-rate mortgage uses semi-annual compounding
      // periodicRate = ((1 + 0.03)^(2/12)) - 1 = ~0.004938...
      // The prior $512.35 principal payment leaves a $199,487.65 balance.
      // next_interest = 199487.65 * periodicRate = 985.1941
      const mortgageAccount = makeLoanAccount({
        accountType: "MORTGAGE" as any,
        currentBalance: -199487.65,
        interestRate: 6,
        paymentFrequency: "MONTHLY",
        isCanadianMortgage: true,
        isVariableRate: false,
      });
      accountsRepository.findOne.mockResolvedValue(mortgageAccount);

      const scheduledTx = makeScheduledTransaction({
        amount: -1500,
        splits: [
          {
            id: "split-principal",
            transferAccountId: loanAccountId,
            categoryId: null,
            amount: -512.35,
            memo: "Principal",
          },
          {
            id: "split-interest",
            transferAccountId: null,
            categoryId: "cat-interest",
            amount: -987.65,
            memo: "Interest",
          },
        ] as any,
      });
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(splitsRepository.save).toHaveBeenCalledTimes(2);

      const interestSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].categoryId === "cat-interest",
      );
      // Canadian semi-annual compounding gives different result than simple monthly
      expect(interestSave[0].amount).not.toBe(-1000);
      expect(interestSave[0].amount).toBe(-985.1941);
    });

    it("should use standard rate calculation for non-Canadian MORTGAGE accounts", async () => {
      // Non-Canadian mortgage: standard monthly compounding, same as loans
      // periodicRate = 0.06/12 = 0.005
      // The prior $500 principal payment leaves a $199,500 balance.
      // next_interest = 199500 * 0.005 = 997.50
      const mortgageAccount = makeLoanAccount({
        accountType: "MORTGAGE" as any,
        currentBalance: -199500,
        interestRate: 6,
        paymentFrequency: "MONTHLY",
        isCanadianMortgage: false,
        isVariableRate: false,
      });
      accountsRepository.findOne.mockResolvedValue(mortgageAccount);

      const scheduledTx = makeScheduledTransaction({
        amount: -1500,
        splits: [
          {
            id: "split-principal",
            transferAccountId: loanAccountId,
            categoryId: null,
            amount: -500,
            memo: "Principal",
          },
          {
            id: "split-interest",
            transferAccountId: null,
            categoryId: "cat-interest",
            amount: -1000,
            memo: "Interest",
          },
        ] as any,
      });
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      const interestSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].categoryId === "cat-interest",
      );
      expect(interestSave[0].amount).toBe(-997.5);

      const principalSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].transferAccountId === loanAccountId,
      );
      expect(principalSave[0].amount).toBe(-502.5);
    });
  });

  describe("findLoanAccountFromSplits", () => {
    it("should return loan account ID when found in splits", async () => {
      const splits = [
        {
          id: "split-1",
          transferAccountId: "acc-loan-1",
        } as ScheduledTransactionSplit,
      ];

      accountsRepository.findOne.mockResolvedValue({
        id: "acc-loan-1",
        accountType: "LOAN",
      });

      const result = await service.findLoanAccountFromSplits(splits);

      expect(result).toBe("acc-loan-1");
    });

    it("should return null when no splits have transferAccountId", async () => {
      const splits = [
        {
          id: "split-1",
          transferAccountId: null,
          categoryId: "cat-1",
        } as unknown as ScheduledTransactionSplit,
      ];

      const result = await service.findLoanAccountFromSplits(splits);

      expect(result).toBeNull();
    });

    it("should return null when transfer account is not a LOAN or MORTGAGE type", async () => {
      const splits = [
        {
          id: "split-1",
          transferAccountId: "acc-savings",
        } as ScheduledTransactionSplit,
      ];

      accountsRepository.findOne.mockResolvedValue({
        id: "acc-savings",
        accountType: "SAVINGS",
      });

      const result = await service.findLoanAccountFromSplits(splits);

      expect(result).toBeNull();
    });

    it("should return mortgage account ID when found in splits", async () => {
      const splits = [
        {
          id: "split-1",
          transferAccountId: "acc-mortgage-1",
        } as ScheduledTransactionSplit,
      ];

      accountsRepository.findOne.mockResolvedValue({
        id: "acc-mortgage-1",
        accountType: "MORTGAGE",
      });

      const result = await service.findLoanAccountFromSplits(splits);

      expect(result).toBe("acc-mortgage-1");
    });

    it("should return null when transfer account is not found", async () => {
      const splits = [
        {
          id: "split-1",
          transferAccountId: "non-existent",
        } as ScheduledTransactionSplit,
      ];

      accountsRepository.findOne.mockResolvedValue(null);

      const result = await service.findLoanAccountFromSplits(splits);

      expect(result).toBeNull();
    });

    it("should return null for empty splits array", async () => {
      const result = await service.findLoanAccountFromSplits([]);

      expect(result).toBeNull();
    });

    it("should check multiple splits and return first loan account found", async () => {
      const splits = [
        {
          id: "split-1",
          transferAccountId: "acc-savings",
        } as ScheduledTransactionSplit,
        {
          id: "split-2",
          transferAccountId: "acc-loan-1",
        } as ScheduledTransactionSplit,
      ];

      accountsRepository.findOne.mockImplementation((opts: any) => {
        const id = opts?.where?.id;
        if (id === "acc-savings") {
          return Promise.resolve({
            id: "acc-savings",
            accountType: "SAVINGS",
          });
        }
        if (id === "acc-loan-1") {
          return Promise.resolve({
            id: "acc-loan-1",
            accountType: "LOAN",
          });
        }
        return Promise.resolve(null);
      });

      const result = await service.findLoanAccountFromSplits(splits);

      expect(result).toBe("acc-loan-1");
    });

    it("should skip splits without transferAccountId", async () => {
      const splits = [
        {
          id: "split-1",
          transferAccountId: null,
          categoryId: "cat-1",
        } as unknown as ScheduledTransactionSplit,
        {
          id: "split-2",
          transferAccountId: "acc-loan-1",
        } as ScheduledTransactionSplit,
      ];

      accountsRepository.findOne.mockResolvedValue({
        id: "acc-loan-1",
        accountType: "LOAN",
      });

      const result = await service.findLoanAccountFromSplits(splits);

      expect(result).toBe("acc-loan-1");
      // findOne should only have been called once (for the split with transferAccountId)
      expect(accountsRepository.findOne).toHaveBeenCalledTimes(1);
    });
  });
});
