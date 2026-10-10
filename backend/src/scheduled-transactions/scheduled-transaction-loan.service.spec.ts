import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { ScheduledTransactionOverride } from "./entities/scheduled-transaction-override.entity";
import { Account, AccountType } from "../accounts/entities/account.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

describe("ScheduledTransactionLoanService", () => {
  let service: ScheduledTransactionLoanService;
  let scheduledTransactionsRepository: Record<string, jest.Mock>;
  let splitsRepository: Record<string, jest.Mock>;
  let accountsRepository: Record<string, jest.Mock>;
  let rateChangesRepository: Record<string, jest.Mock>;
  let overridesRepository: Record<string, jest.Mock>;
  let manager: Record<string, jest.Mock>;

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
      nextDueDate: "2026-06-01",
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

    // Most loans have no recorded rate history, so the bill falls back to the
    // account's own scalar; the rate-timeline tests override this.
    rateChangesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    overridesRepository = {
      find: jest.fn().mockResolvedValue([]),
    };

    const scopedDb = createScopedDbMocks([
      [ScheduledTransaction, scheduledTransactionsRepository],
      [ScheduledTransactionSplit, splitsRepository],
      [Account, accountsRepository],
      [LoanRateChange, rateChangesRepository],
      [ScheduledTransactionOverride, overridesRepository],
    ]);
    manager = scopedDb.manager;
    // The dated ledger balance comes from a raw as-of query; by default answer
    // it with the mocked account's stored balance, so tests exercising other
    // behavior read the same figure the old currentBalance read gave them. A
    // test about the DATED balance overrides this with its own rows.
    manager.query.mockImplementation(async (sql: unknown) => {
      if (String(sql).includes("opening_balance")) {
        const account = await accountsRepository.findOne();
        return account != null
          ? [{ balance: String(Number(account.currentBalance)) }]
          : [];
      }
      return [];
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTransactionLoanService,
        { provide: DataSource, useValue: scopedDb.dataSource },
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

    it("declines a template carrying a line it cannot account for", async () => {
      // Escrow beside principal and interest. Preferring the configured interest
      // category fixes WHICH line gets the amortization figure, but not the
      // arithmetic: the parent is rewritten to principal + interest + extra,
      // which is not this template's total, so parent and children stop
      // matching and the posting path's exact-4dp validator refuses every
      // occurrence from then on. Declining leaves a slightly stale P/I split;
      // rewriting leaves a bill that never posts again.
      const loanAccount = makeLoanAccount({
        currentBalance: -20000,
        interestCategoryId: "cat-interest",
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
              amount: -390,
              memo: "Principal",
            },
            {
              id: "split-escrow",
              transferAccountId: null,
              categoryId: "cat-escrow",
              amount: -200,
              memo: "Property tax",
            },
            {
              id: "split-interest",
              transferAccountId: null,
              categoryId: "cat-interest",
              amount: -110,
              memo: "Interest",
            },
          ],
        } as unknown as Partial<ScheduledTransaction>),
      );

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(splitsRepository.save).not.toHaveBeenCalled();
      expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
    });

    it("declines when no line carries the configured interest category", async () => {
      // The loan says its interest category is X and the template's only
      // categorized line is Y: nothing here identifies interest, and the old
      // code would have written the amortization figure onto Y by position.
      const loanAccount = makeLoanAccount({
        currentBalance: -20000,
        interestCategoryId: "cat-interest",
      });
      accountsRepository.findOne.mockResolvedValue(loanAccount);
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction({
          amount: -590,
          splits: [
            {
              id: "split-principal",
              transferAccountId: loanAccountId,
              categoryId: null,
              amount: -390,
              memo: "Principal",
            },
            {
              id: "split-escrow",
              transferAccountId: null,
              categoryId: "cat-escrow",
              amount: -200,
              memo: "Property tax",
            },
          ],
        } as unknown as Partial<ScheduledTransaction>),
      );

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(splitsRepository.save).not.toHaveBeenCalled();
      expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
    });

    it("recalculates the canonical principal + interest template", async () => {
      // The shape this service writes itself, with the interest category
      // configured: identified by provenance, and fully accounted for, so the
      // parent and children stay in step.
      const loanAccount = makeLoanAccount({
        currentBalance: -20000,
        interestCategoryId: "cat-interest",
      });
      accountsRepository.findOne.mockResolvedValue(loanAccount);
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction(),
      );

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      const saved = splitsRepository.save.mock.calls.map(
        (call: any) => call[0],
      );
      expect(saved.some((sp: any) => sp.id === "split-interest")).toBe(true);
      expect(saved.some((sp: any) => sp.id === "split-principal")).toBe(true);
    });

    it("keeps the parent equal to the sum of its children on a multi-line template", async () => {
      // The posting path validates parent == sum(children) to exact 4dp. This
      // method rewrites the parent to principal + interest + extra, which is the
      // whole template only when there are no other lines -- so an escrow line
      // it leaves untouched puts the two out of balance and the occurrence stops
      // posting.
      const loanAccount = makeLoanAccount({
        currentBalance: -20000,
        interestCategoryId: "cat-interest",
      });
      accountsRepository.findOne.mockResolvedValue(loanAccount);
      const splits = [
        {
          id: "split-principal",
          transferAccountId: loanAccountId,
          categoryId: null,
          amount: -390,
          memo: "Principal",
        },
        {
          id: "split-escrow",
          transferAccountId: null,
          categoryId: "cat-escrow",
          amount: -200,
          memo: "Property tax",
        },
        {
          id: "split-interest",
          transferAccountId: null,
          categoryId: "cat-interest",
          amount: -110,
          memo: "Interest",
        },
      ];
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction({
          amount: -700,
          splits,
        } as unknown as Partial<ScheduledTransaction>),
      );

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      // Whatever it decided to do, the template must still balance.
      const updateCalls = scheduledTransactionsRepository.update.mock.calls;
      const parentUpdate = updateCalls.length
        ? updateCalls[updateCalls.length - 1][1]
        : undefined;
      const parentAmount = parentUpdate
        ? Math.abs(Number(parentUpdate.amount))
        : 700;
      const childSum = splits.reduce(
        (total: number, sp: any) => total + Math.abs(Number(sp.amount)),
        0,
      );
      expect(parentAmount).toBeCloseTo(childSum, 4);
    });

    describe("the stored cadence decides the periodic rate", () => {
      /**
       * `accounts.payment_frequency` is a bare VARCHAR written in two spellings,
       * and this path cast it into `MortgagePaymentFrequency` before asking
       * `getMortgagePeriodsPerYear` -- whose `default: 12` turned SEMIMONTHLY
       * into a monthly rate. Every posted split on a semi-monthly mortgage then
       * carried twice the correct interest, for the life of the loan; quarterly
       * carried three times.
       *
       * Asserted on the balance-based branch (no previous split figures), where
       * the interest is exactly `balance * periodicRate` and the expectation can
       * be derived by hand rather than from the implementation.
       */
      const splitsWithNoHistory = () => [
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
      ];

      it.each([
        // 300000 at 6% nominal. 24 periods a year is 0.0025 per period: 750.
        ["SEMIMONTHLY", 24, 750],
        ["SEMI_MONTHLY", 24, 750],
        // 12 a year is 0.005: 1500. The value the cast used to produce for all
        // three of these rows.
        ["MONTHLY", 12, 1500],
        // 4 a year is 0.015: 4500 -- three times what the cast reported.
        ["QUARTERLY", 4, 4500],
        // 1 a year is 0.06: 18000.
        ["YEARLY", 1, 18000],
        ["BIWEEKLY", 26, 692.31],
        ["ACCELERATED_BIWEEKLY", 26, 692.31],
      ])(
        "books %s interest at %i periods a year",
        async (paymentFrequency, _periods, expectedInterest) => {
          accountsRepository.findOne.mockResolvedValue(
            makeLoanAccount({
              accountType: AccountType.MORTGAGE,
              currentBalance: -300000,
              interestRate: 6,
              paymentFrequency,
              isCanadianMortgage: false,
              isVariableRate: false,
            }),
          );
          scheduledTransactionsRepository.findOne.mockResolvedValue(
            makeScheduledTransaction({
              amount: -20000,
              splits: splitsWithNoHistory() as never,
            }),
          );

          await service.recalculateLoanPaymentSplits(scheduledTransactionId);

          const interestSave = splitsRepository.save.mock.calls.find(
            (call: any) => call[0].categoryId === "cat-interest",
          );
          expect(interestSave).toBeDefined();
          expect(interestSave[0].amount).toBeCloseTo(-expectedInterest, 2);
        },
      );
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

    it("leaves a revolving line of credit active when it owes nothing", async () => {
      // A LOC at a zero (or credit) balance is not a finished loan -- the user
      // can draw on it again tomorrow, and deactivating its schedule is not
      // recoverable from the UI. This matters since the debt became
      // `max(0, -balance)`: an overpaid account in credit now reads as owing
      // nothing, where the old `Math.abs` read a credit balance as fresh debt.
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({
          accountType: AccountType.LINE_OF_CREDIT,
          currentBalance: 200,
        }),
      );
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction(),
      );

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
      expect(splitsRepository.save).not.toHaveBeenCalled();
    });

    it("still deactivates an amortizing loan that is paid off", async () => {
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({ accountType: AccountType.LOAN, currentBalance: 0 }),
      );
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction(),
      );

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
      // The prior stored split is deliberately a cent away from the balance
      // (issue #1253). Advancing it with the amortization recurrence would
      // produce 100.01 - 399.99 * 0.005 = 98.0101; the ledger balance gives
      // the authoritative 19,600 * 0.005 = 98.0000.
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

    it("prices at the rate in effect on the due date, not the account's stale scalar", async () => {
      // Recording a rate change deliberately does not write
      // `accounts.interest_rate`, so a loan whose rate moved to 7.2% still
      // carries 6 in that column. Pricing the bill at the scalar charges a rate
      // nobody pays -- and disagrees with the amortization report, which reads
      // the timeline (issue #1253, INV-LOAN-006).
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({
          currentBalance: -200000,
          interestRate: 6,
          paymentFrequency: "MONTHLY",
          paymentAmount: 1500,
        }),
      );
      rateChangesRepository.find.mockResolvedValue([
        { effectiveDate: "2026-01-01", annualRate: "7.2000" },
      ]);
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction({ amount: -1500, nextDueDate: "2026-08-01" }),
      );

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      // 200,000 x (7.2 / 100 / 12) = 1,200.00, not the scalar's 1,000.00.
      const interestSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].categoryId === "cat-interest",
      );
      expect(interestSave[0].amount).toBe(-1200);
    });

    it("leaves a rate change dated after the due date to a later installment", async () => {
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({
          currentBalance: -200000,
          interestRate: 6,
          paymentFrequency: "MONTHLY",
          paymentAmount: 1500,
        }),
      );
      rateChangesRepository.find.mockResolvedValue([
        { effectiveDate: "2026-09-01", annualRate: "7.2000" },
      ]);
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction({ amount: -1500, nextDueDate: "2026-08-01" }),
      );

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      const interestSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].categoryId === "cat-interest",
      );
      expect(interestSave[0].amount).toBe(-1000);
    });

    /**
     * The dated payment (INV-LOAN-009, `docs/specs/scheduled-loan-installment-pricing.md`
     * table 5.3, Timeline B on fixture 5.1): the advancement after installment
     * 16 posted on 2024-05-03 moves the template to 2024-06-03, the first
     * installment the 4.5 % / 557.00 change effective 2024-05-15 applies to,
     * and the template steps into 557.00 exactly, down from 584.59.
     */
    describe("the advancement steps into a stated payment (spec 7.3)", () => {
      const fixtureAccount = () =>
        makeLoanAccount({
          accountType: "MORTGAGE",
          mortgageType: "ANNUITY",
          currentBalance: -97227.62,
          interestRate: 5,
          paymentFrequency: "MONTHLY",
          paymentAmount: 584.59,
          paymentStartDate: "2023-02-03",
          amortizationMonths: 300,
          originalPrincipal: 100000,
        } as unknown as Partial<Account>);
      const initial = {
        effectiveDate: "2023-02-03",
        annualRate: "5.0000",
        newPaymentAmount: "584.5900",
        source: "initial",
      };
      const template = (amount: number) =>
        makeScheduledTransaction({
          amount: -amount,
          startDate: "2023-02-03",
          nextDueDate: "2024-06-03",
          splits: [
            {
              id: "split-principal",
              transferAccountId: loanAccountId,
              categoryId: null,
              amount: -178.73,
              memo: "Principal",
            },
            {
              id: "split-interest",
              transferAccountId: null,
              categoryId: "cat-interest",
              amount: -405.86,
              memo: "Interest",
            },
          ],
        } as never);
      const cents = (value: number) => Math.round(value * 100) / 100;
      const written = () => {
        const parent = scheduledTransactionsRepository.update.mock.calls.find(
          (call: any) => call[1]?.amount !== undefined,
        );
        const interest = splitsRepository.save.mock.calls.find(
          (call: any) => call[0].categoryId === "cat-interest",
        );
        const principal = splitsRepository.save.mock.calls.find(
          (call: any) => call[0].transferAccountId === loanAccountId,
        );
        return {
          parent: parent ? parent[1].amount : undefined,
          interest: cents(interest![0].amount),
          principal: cents(principal![0].amount),
        };
      };

      it("rewrites the template from 584.59 to 557.00 = 364.60 + 192.40 at the first installment the change applies to", async () => {
        accountsRepository.findOne.mockResolvedValue(fixtureAccount());
        rateChangesRepository.find.mockResolvedValue([
          initial,
          {
            effectiveDate: "2024-05-15",
            annualRate: "4.5000",
            newPaymentAmount: "557.0000",
            source: "manual",
          },
        ]);
        scheduledTransactionsRepository.findOne.mockResolvedValue(
          template(584.59),
        );

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        expect(written()).toEqual({
          parent: -557,
          interest: -364.6,
          principal: -192.4,
        });
      });

      it("keeps a user-raised template of 600.00 when no new change applies", async () => {
        accountsRepository.findOne.mockResolvedValue(fixtureAccount());
        rateChangesRepository.find.mockResolvedValue([initial]);
        scheduledTransactionsRepository.findOne.mockResolvedValue(
          template(600),
        );

        await service.recalculateLoanPaymentSplits(scheduledTransactionId);

        // max(600.00, 584.59): the parent is not rewritten, the lines are.
        expect(written()).toEqual({
          parent: undefined,
          interest: -405.12,
          principal: -194.88,
        });
      });
    });

    it("measures the balance from the ledger through the next due date", async () => {
      // `accounts.current_balance` excludes future-dated rows, so after a
      // future-dated regular or principal-only payment posts it repeats the
      // old balance. The as-of ledger query includes every non-void, top-level
      // transaction through the schedule's next due date: 200,000 of stored
      // debt less a posted 1,500 principal payment leaves 198,500, so the next
      // interest is 992.50, not 1,000.00.
      const loanAccount = makeLoanAccount({
        currentBalance: -200000,
        interestRate: 6,
        paymentFrequency: "MONTHLY",
        paymentAmount: 1500,
      });
      accountsRepository.findOne.mockResolvedValue(loanAccount);
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction({
          amount: -1500,
          nextDueDate: "2026-08-01",
        }),
      );

      manager.query.mockResolvedValue([{ balance: "-198500" }]);

      await service.recalculateLoanPaymentSplits(scheduledTransactionId);

      // The boundary is the schedule's own next due date: rows dated on or
      // before it count, later rows belong to later installments.
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining("t.transaction_date <= $3"),
        [loanAccountId, userId, "2026-08-01"],
      );
      const interestSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].categoryId === "cat-interest",
      );
      expect(interestSave[0].amount).toBe(-992.5);
      const principalSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].transferAccountId === loanAccountId,
      );
      expect(principalSave[0].amount).toBe(-507.5);
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
      // periodicRate = ((1 + 0.03)^(2/12)) - 1 = ~0.0049386
      // The prior $512.35 principal payment left a $199,487.65 balance:
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

    it("prices by the stored mortgage type over the flags", async () => {
      // The column is the type; the flags are only its fallback while the
      // column is null. Each row below disagrees with its own flags, so the
      // interest shows which one priced it (the figures of the two tests
      // around this one).
      const splits = [
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
      ] as any;
      const interestFor = async (overrides: Partial<Account>) => {
        splitsRepository.save.mockClear();
        accountsRepository.findOne.mockResolvedValue(
          makeLoanAccount({
            accountType: "MORTGAGE" as any,
            currentBalance: -199487.65,
            interestRate: 6,
            paymentFrequency: "MONTHLY",
            ...overrides,
          }),
        );
        scheduledTransactionsRepository.findOne.mockResolvedValue(
          makeScheduledTransaction({ amount: -1500, splits }),
        );
        await service.recalculateLoanPaymentSplits(scheduledTransactionId);
        return splitsRepository.save.mock.calls.find(
          (call: any) => call[0].categoryId === "cat-interest",
        )[0].amount;
      };

      expect(
        await interestFor({
          mortgageType: "CANADIAN_FIXED",
          isCanadianMortgage: false,
          isVariableRate: false,
        }),
      ).toBe(-985.1941);
      // 199,487.65 x 0.06 / 12
      expect(
        await interestFor({
          mortgageType: "ANNUITY",
          isCanadianMortgage: true,
          isVariableRate: false,
        }),
      ).toBe(-997.4383);
    });

    it("should use standard rate calculation for non-Canadian MORTGAGE accounts", async () => {
      // Non-Canadian mortgage: standard monthly compounding, same as loans
      // periodicRate = 0.06/12 = 0.005
      // The prior $500 principal payment left a $199,500 balance:
      // next_interest = 199500 * 0.005 = 997.50
      // next_principal = 1500 - 997.50 = 502.50
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

  describe("bookTemplateAtMinorUnit", () => {
    it("books the stored template the way the Post dialog pre-fills it", async () => {
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      const booked = await service.bookTemplateAtMinorUnit(
        makeScheduledTransaction({ amount: -1170.6458, currencyCode: "EUR" }),
        [
          {
            id: "split-interest",
            transferAccountId: null,
            categoryId: "cat-interest",
            amount: -306.0625,
            memo: "Interest",
          },
          {
            id: "split-principal",
            transferAccountId: loanAccountId,
            categoryId: null,
            amount: -864.5833,
            memo: "Principal",
          },
        ] as unknown as ScheduledTransactionSplit[],
      );
      expect(booked).toEqual({
        amountsBySplitId: new Map([
          ["split-interest", -306.06],
          ["split-principal", -864.59],
        ]),
        parentAmount: -1170.65,
      });
    });

    it("gives the rounding to the largest line of a split set that pays no loan", async () => {
      accountsRepository.findOne.mockResolvedValue({
        id: "acc-savings",
        accountType: "SAVINGS",
      });
      const booked = await service.bookTemplateAtMinorUnit(
        makeScheduledTransaction({ amount: -100, currencyCode: "EUR" }),
        [
          {
            id: "split-a",
            transferAccountId: "acc-savings",
            categoryId: null,
            amount: -33.335,
            memo: null,
          },
          {
            id: "split-b",
            transferAccountId: null,
            categoryId: "cat-x",
            amount: -66.665,
            memo: null,
          },
        ] as unknown as ScheduledTransactionSplit[],
      );
      // 33.34 + 66.67 = 100.01 against a 100.00 parent: the cent comes
      // back off the larger line.
      expect(booked).toEqual({
        amountsBySplitId: new Map([
          ["split-a", -33.34],
          ["split-b", -66.66],
        ]),
        parentAmount: -100,
      });
    });
  });

  describe("resolvePostingAllocation", () => {
    const templateSplits = () =>
      [
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
      ] as unknown as ScheduledTransactionSplit[];

    it("re-resolves the split amounts from the ledger at the posting boundary", async () => {
      // The stored template was computed when the previous occurrence posted
      // (1,000 interest on 200,000 at 6% monthly). A standalone 1,500
      // principal-only payment has landed since, so the debt applicable to
      // this occurrence is 198,500 and the occurrence must post 992.50 of
      // interest and 507.50 of principal -- not the stale stored split
      // (issue #1253, finding PR-1254-01).
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({
          currentBalance: -200000,
          interestRate: 6,
          paymentFrequency: "MONTHLY",
          paymentAmount: 1500,
        }),
      );
      manager.query.mockResolvedValue([{ balance: "-198500" }]);

      const result = await service.resolvePostingAllocation(
        makeScheduledTransaction({ amount: -1500 }),
        templateSplits(),
        "2026-06-01",
      );

      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining("t.transaction_date <= $3"),
        [loanAccountId, userId, "2026-06-01"],
      );
      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.amountsBySplitId.get("split-interest")).toBe(-992.5);
      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.amountsBySplitId.get("split-principal")).toBe(-507.5);
      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.parentAmount).toBe(-1500);
    });

    it("resolves to exactly the persisted amounts when nothing moved in between", async () => {
      // Idempotence: the recalculation after the previous posting and this
      // resolution price through the same code against the same boundary, so
      // an undisturbed ledger yields the template byte for byte.
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({
          currentBalance: -200000,
          interestRate: 6,
          paymentFrequency: "MONTHLY",
          paymentAmount: 1500,
        }),
      );

      const result = await service.resolvePostingAllocation(
        makeScheduledTransaction({ amount: -1500 }),
        templateSplits(),
        "2026-06-01",
      );

      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.amountsBySplitId.get("split-interest")).toBe(-1000);
      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.amountsBySplitId.get("split-principal")).toBe(-500);
      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.parentAmount).toBe(-1500);
    });

    describe("books the installment in the currency's smallest unit (issue #1581)", () => {
      // A 1,170.6458 installment priced at storage precision: 306.0625 of
      // interest (61,212.50 at 6% monthly) and 864.5833 of principal. The
      // account it debits moves whole cents.
      const subCentSplits = () =>
        [
          {
            id: "split-principal",
            transferAccountId: loanAccountId,
            categoryId: null,
            amount: -864.5833,
            memo: "Principal",
          },
          {
            id: "split-interest",
            transferAccountId: null,
            categoryId: "cat-interest",
            amount: -306.0625,
            memo: "Interest",
          },
        ] as unknown as ScheduledTransactionSplit[];

      const resolve = async (currencyCode: string) => {
        accountsRepository.findOne.mockResolvedValue(
          makeLoanAccount({
            currentBalance: -61212.5,
            interestRate: 6,
            paymentFrequency: "MONTHLY",
          }),
        );
        manager.query.mockResolvedValue([{ balance: "-61212.5" }]);
        const result = await service.resolvePostingAllocation(
          makeScheduledTransaction({ amount: -1170.6458, currencyCode }),
          subCentSplits(),
          "2026-06-01",
        );
        if (result.kind !== "allocation") throw new Error("unreachable");
        return result;
      };

      it("posts 1,170.65 as 864.59 principal and 306.06 interest", async () => {
        const result = await resolve("EUR");
        expect(result.parentAmount).toBe(-1170.65);
        expect(result.amountsBySplitId.get("split-interest")).toBe(-306.06);
        expect(result.amountsBySplitId.get("split-principal")).toBe(-864.59);
      });

      it("posts whole units for a currency without a minor unit", async () => {
        const result = await resolve("JPY");
        expect(result.parentAmount).toBe(-1171);
        expect(result.amountsBySplitId.get("split-interest")).toBe(-306);
        expect(result.amountsBySplitId.get("split-principal")).toBe(-865);
      });
    });

    it("writes nothing while resolving", async () => {
      // The posting path calls this inside its own transaction to shape the
      // payload; the template itself is advanced by the recalculation after
      // the post, not here.
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());

      await service.resolvePostingAllocation(
        makeScheduledTransaction(),
        templateSplits(),
        "2026-06-01",
      );

      expect(splitsRepository.save).not.toHaveBeenCalled();
      expect(scheduledTransactionsRepository.update).not.toHaveBeenCalled();
    });

    it("returns null when the splits do not transfer to a loan-like account", async () => {
      accountsRepository.findOne.mockResolvedValue({
        id: "acc-savings",
        accountType: "SAVINGS",
      });

      const result = await service.resolvePostingAllocation(
        makeScheduledTransaction(),
        [
          {
            id: "split-1",
            transferAccountId: "acc-savings",
            amount: -100,
          } as unknown as ScheduledTransactionSplit,
        ],
        "2026-06-01",
      );

      expect(result.kind).toBe("not-applicable");
    });

    it("returns null for a template shape the recalculation would decline", async () => {
      // An escrow line beside principal/interest: repricing only the managed
      // lines would leave the parent unequal to the sum of its children, so
      // the posting proceeds on the persisted amounts, exactly as the
      // recalculation declines to rewrite them.
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({ interestCategoryId: "cat-interest" }),
      );

      const result = await service.resolvePostingAllocation(
        makeScheduledTransaction({ amount: -1700 }),
        [
          ...templateSplits(),
          {
            id: "split-escrow",
            transferAccountId: null,
            categoryId: "cat-escrow",
            amount: -200,
            memo: "Property tax",
          } as unknown as ScheduledTransactionSplit,
        ],
        "2026-06-01",
      );

      expect(result.kind).toBe("not-applicable");
    });

    it("re-divides the bill it was shown and never resizes it", async () => {
      // The account's configured payment (2,000) is larger than the template
      // parent (1,500) the bills page and the Post dialog displayed. The
      // recalculation may grow the parent back toward the configured figure
      // (review #1131), but a POSTING may not: doing so moves 500 more than
      // any surface showed, which is a preview/commit divergence.
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({
          currentBalance: -200000,
          interestRate: 6,
          paymentFrequency: "MONTHLY",
          paymentAmount: 2000,
        }),
      );

      const result = await service.resolvePostingAllocation(
        makeScheduledTransaction({ amount: -1500 }),
        templateSplits(),
        "2026-06-01",
      );

      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.parentAmount).toBe(-1500);
      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.amountsBySplitId.get("split-interest")).toBe(-1000);
      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.amountsBySplitId.get("split-principal")).toBe(-500);
    });

    it("refuses rather than posting a stale split when the ledger cannot be read", async () => {
      // A failed read is not "this is not a loan template". Returning null
      // there would post the stored split -- the exact stale-template posting
      // this method exists to prevent -- so the occurrence refuses and the
      // posting transaction rolls back.
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      manager.query.mockResolvedValue([]);

      await expect(
        service.resolvePostingAllocation(
          makeScheduledTransaction(),
          templateSplits(),
          "2026-06-01",
        ),
      ).rejects.toThrow(/could not be read/i);
    });

    it("reports a retired debt as retired, not as 'not a loan template'", async () => {
      // These are different instructions and the caller acts on them
      // differently. Collapsed into one answer, the posting read "not a loan
      // template" as "use the persisted amounts" and charged the whole stale
      // installment against a debt that no longer exists.
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      manager.query.mockResolvedValue([{ balance: "0" }]);

      const result = await service.resolvePostingAllocation(
        makeScheduledTransaction(),
        templateSplits(),
        "2026-06-01",
      );

      expect(result.kind).toBe("retired");
    });

    it("does not call a retired escrow-carrying template retired", async () => {
      // The payoff settles the mortgage principal; the escrow line is still
      // owed. Reporting "retired" here would make the posting withhold a
      // payment the user genuinely has to make.
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({ interestCategoryId: "cat-interest" }),
      );
      manager.query.mockResolvedValue([{ balance: "0" }]);

      const result = await service.resolvePostingAllocation(
        makeScheduledTransaction({ amount: -1700 }),
        [
          ...templateSplits(),
          {
            id: "split-escrow",
            transferAccountId: null,
            categoryId: "cat-escrow",
            amount: -200,
            memo: "Property tax",
          } as unknown as ScheduledTransactionSplit,
        ],
        "2026-06-01",
      );

      expect(result.kind).toBe("not-applicable");
    });

    it("resolves the extra-principal line alongside principal and interest", async () => {
      // 50,000 at 2.4% (100 interest), configured payment 1,000 with a 300
      // standing extra: 100 interest + 600 principal + 300 extra.
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({
          currentBalance: -50000,
          interestRate: 2.4,
          paymentAmount: 1000,
          extraPaymentAmount: 300,
        }),
      );

      const result = await service.resolvePostingAllocation(
        makeScheduledTransaction({
          amount: -1000,
          splits: [] as never,
        }),
        [
          {
            id: "split-principal",
            transferAccountId: loanAccountId,
            categoryId: null,
            amount: -600,
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
            amount: -100,
            memo: "Interest",
          },
        ] as unknown as ScheduledTransactionSplit[],
        "2026-06-01",
      );

      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.amountsBySplitId.get("split-interest")).toBe(-100);
      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.amountsBySplitId.get("split-principal")).toBe(-600);
      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.amountsBySplitId.get("split-extra")).toBe(-300);
      expect(result.kind).toBe("allocation");
      if (result.kind !== "allocation") throw new Error("unreachable");
      expect(result.parentAmount).toBe(-1000);
    });
  });

  describe("getLoanProjectionAnchor", () => {
    it("returns the next due date and the debt through it", async () => {
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({ currentBalance: -200000 }),
      );
      manager.query.mockImplementation(async (sql: unknown) => {
        const text = String(sql);
        if (text.includes("scheduled_transactions")) {
          return [{ next_due_date: "2026-08-01" }];
        }
        if (text.includes("opening_balance")) {
          // The ledger through 2026-08-01 already includes a future-dated
          // 1,500 principal payment the stored balance excludes.
          return [{ balance: "-198500" }];
        }
        return [];
      });

      const result = await service.getLoanProjectionAnchor(
        userId,
        loanAccountId,
      );

      expect(result).toEqual({ nextDueDate: "2026-08-01", debt: 198500 });
      // The balance is measured through the schedule's due date, the same
      // boundary the scheduled bill's interest uses.
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining("t.transaction_date <= $3"),
        [loanAccountId, userId, "2026-08-01"],
      );
    });

    it("anchors on the schedule the account names, not the soonest transfer into it", async () => {
      // A standalone extra-principal transfer due sooner than the P/I bill is
      // an ordinary configuration. Anchoring on it would date the report's
      // first row to an installment no bill will ever post.
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({ scheduledTransactionId: "st-bill" } as never),
      );
      manager.query.mockImplementation(
        async (sql: unknown, params?: unknown[]) => {
          const text = String(sql);
          if (text.includes("scheduled_transactions")) {
            // The account's own pointer is the third parameter, and the query
            // must select on it rather than on any transfer into the loan.
            expect((params as unknown[])[2]).toBe("st-bill");
            return [{ next_due_date: "2026-09-01" }];
          }
          return [{ balance: "-198500" }];
        },
      );

      const result = await service.getLoanProjectionAnchor(
        userId,
        loanAccountId,
      );

      expect(result.nextDueDate).toBe("2026-09-01");
    });

    it("falls back to either spelling of the transfer linkage when the account names no schedule", async () => {
      // A loan set up before the pointer existed: a schedule naming the loan
      // by its top-level transfer column OR by a split still anchors it.
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      let sql = "";
      manager.query.mockImplementation(async (statement: unknown) => {
        const text = String(statement);
        if (text.includes("scheduled_transactions")) {
          sql = text;
          return [{ next_due_date: "2026-09-01" }];
        }
        return [{ balance: "-198500" }];
      });

      await service.getLoanProjectionAnchor(userId, loanAccountId);

      expect(sql).toContain("st.transfer_account_id");
      expect(sql).toContain("scheduled_transaction_splits");
    });

    it("refuses rather than reporting no schedule when the ledger cannot be read", async () => {
      // {null, null} is defined to mean "no scheduled payment", which the
      // report reads as licence to project from today's balance -- the drift
      // this endpoint closes. A failed read must not wear that answer.
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      manager.query.mockImplementation(async (sql: unknown) => {
        if (String(sql).includes("scheduled_transactions")) {
          return [{ next_due_date: "2026-09-01" }];
        }
        return [];
      });

      await expect(
        service.getLoanProjectionAnchor(userId, loanAccountId),
      ).rejects.toThrow(/could not be read/i);
    });

    it("asks the override table for the date the occurrence moved to", async () => {
      // Shape only: a mocked `query` returns whatever this spec hands it, so
      // it cannot prove WHICH date the statement selects -- that property
      // belongs to PostgreSQL and is asserted in
      // test/integration/scheduled-loan-dated-balance.integration.spec.ts
      // ("anchors on the date an override moved the occurrence to").
      // What this pins is that the lookup joins the override at all.
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      let sql = "";
      manager.query.mockImplementation(async (statement: unknown) => {
        const text = String(statement);
        if (text.includes("scheduled_transactions")) {
          sql = text;
          return [{ next_due_date: "2026-08-25" }];
        }
        return [{ balance: "-195500" }];
      });

      const result = await service.getLoanProjectionAnchor(
        userId,
        loanAccountId,
      );

      expect(sql).toContain("scheduled_transaction_overrides");
      expect(sql).toContain("ovr.original_date = st.next_due_date");
      expect(result.nextDueDate).toBe("2026-08-25");
      // ...and the debt is measured through the date it actually falls on.
      expect(manager.query).toHaveBeenCalledWith(
        expect.stringContaining("t.transaction_date <= $3"),
        [loanAccountId, userId, "2026-08-25"],
      );
    });

    it("returns nulls when the loan has no active scheduled payment", async () => {
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      manager.query.mockResolvedValue([]);

      const result = await service.getLoanProjectionAnchor(
        userId,
        loanAccountId,
      );

      expect(result).toEqual({ nextDueDate: null, debt: null });
    });

    it("returns nulls for an account that is not loan-like", async () => {
      accountsRepository.findOne.mockResolvedValue({
        id: "acc-savings",
        accountType: "SAVINGS",
      });

      const result = await service.getLoanProjectionAnchor(
        userId,
        "acc-savings",
      );

      expect(result).toEqual({ nextDueDate: null, debt: null });
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("returns nulls for an account that does not exist", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      const result = await service.getLoanProjectionAnchor(
        userId,
        loanAccountId,
      );

      expect(result).toEqual({ nextDueDate: null, debt: null });
    });

    it("reports an overpaid (in credit) loan as zero debt, not fresh debt", async () => {
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      manager.query.mockImplementation(async (sql: unknown) => {
        const text = String(sql);
        if (text.includes("scheduled_transactions")) {
          return [{ next_due_date: "2026-08-01" }];
        }
        return [{ balance: "200.00" }];
      });

      const result = await service.getLoanProjectionAnchor(
        userId,
        loanAccountId,
      );

      expect(result).toEqual({ nextDueDate: "2026-08-01", debt: 0 });
    });
  });

  /**
   * The projection read (`docs/specs/scheduled-loan-installment-pricing.md`
   * section 8). The numbers are the pure fold's own spec's; these cases are
   * about what the service reads, refuses and hands over: fixture 5.1 with
   * Timeline A, nothing posted, the cursor at 2023-02-03.
   */
  describe("projectLoanOccurrences", () => {
    const annuityMortgage = (overrides: Partial<Account> = {}): Account =>
      makeLoanAccount({
        accountType: "MORTGAGE" as AccountType,
        mortgageType: "ANNUITY",
        interestRate: 5,
        paymentAmount: 584.59,
        paymentStartDate: "2023-02-03",
        amortizationMonths: 300,
        currentBalance: -100000,
        currencyCode: "CAD",
        interestCategoryId: "cat-interest",
        ...overrides,
      } as Partial<Account>);

    const mortgageSchedule = (
      overrides: Partial<ScheduledTransaction> = {},
    ): ScheduledTransaction =>
      makeScheduledTransaction({
        amount: -584.59,
        startDate: "2023-02-03",
        nextDueDate: "2023-02-03",
        endDate: null,
        occurrencesRemaining: null,
        currencyCode: "CAD",
        splits: [
          {
            id: "split-principal",
            transferAccountId: loanAccountId,
            categoryId: null,
            amount: -167.92,
            memo: "Principal",
          },
          {
            id: "split-interest",
            transferAccountId: null,
            categoryId: "cat-interest",
            amount: -416.67,
            memo: "Interest",
          },
        ],
        ...overrides,
      } as Partial<ScheduledTransaction>);

    const timelineA = [
      {
        effectiveDate: "2023-02-03",
        annualRate: 5,
        newPaymentAmount: 584.59,
        source: "initial",
      },
      {
        effectiveDate: "2023-04-15",
        annualRate: 4.5,
        newPaymentAmount: 560,
        source: "manual",
      },
    ];

    /** The as-of SQL in both shapes: one date, or one row per date asked for. */
    const ledgerAt = (balance: string | null) =>
      manager.query.mockImplementation(
        async (sql: unknown, params?: unknown[]) => {
          const text = String(sql);
          if (text.includes("unnest")) {
            if (balance === null) return [];
            return (params?.[2] as string[]).map((as_of) => ({
              as_of,
              balance,
            }));
          }
          if (text.includes("opening_balance")) {
            return balance === null ? [] : [{ balance }];
          }
          return [];
        },
      );

    beforeEach(() => {
      accountsRepository.findOne.mockResolvedValue(annuityMortgage());
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        mortgageSchedule(),
      );
      rateChangesRepository.find.mockResolvedValue(timelineA);
      ledgerAt("-100000");
    });

    it("prices the next occurrences at their own dates, the identity from the one expander, the ledger in one statement", async () => {
      const result = await service.projectLoanOccurrences(
        userId,
        scheduledTransactionId,
        5,
      );

      expect(result).toMatchObject({
        scheduledTransactionId,
        loanAccountId,
        status: "priced",
        currencyCode: "CAD",
      });
      expect(
        result.occurrences.map((o) => [o.dueDate, o.amount, o.interest]),
      ).toEqual([
        ["2023-02-03", 584.59, 416.67],
        ["2023-03-03", 584.59, 415.97],
        ["2023-04-03", 584.59, 415.26],
        ["2023-05-03", 560, 373.1],
        ["2023-06-03", 560, 372.4],
      ]);
      // The schedule is read for the caller, and the ledger once, for every
      // date the five occurrences fall on.
      expect(scheduledTransactionsRepository.findOne).toHaveBeenCalledWith({
        where: { id: scheduledTransactionId, userId },
      });
      const ledgerCalls = manager.query.mock.calls.filter(([sql]) =>
        String(sql).includes("unnest"),
      );
      expect(ledgerCalls).toHaveLength(1);
      expect(ledgerCalls[0][1]).toEqual([
        loanAccountId,
        userId,
        ["2023-02-03", "2023-03-03", "2023-04-03", "2023-05-03", "2023-06-03"],
      ]);
    });

    it("prices the first occurrence as the posting boundary prices it on the same ledger (INV-LOAN-006)", async () => {
      const scheduled = mortgageSchedule();
      const posting = await service.resolvePostingAllocation(
        scheduled,
        scheduled.splits as unknown as ScheduledTransactionSplit[],
        "2023-02-03",
      );
      const [first] = (
        await service.projectLoanOccurrences(userId, scheduledTransactionId, 1)
      ).occurrences;

      expect(posting.kind).toBe("allocation");
      if (posting.kind !== "allocation") return;
      expect(first.amount).toBe(-posting.parentAmount);
      expect(first.principal).toBe(
        -Number(posting.amountsBySplitId.get("split-principal")),
      );
      expect(first.interest).toBe(
        -Number(posting.amountsBySplitId.get("split-interest")),
      );
      // And it is the stored template, which is what the occurrence service
      // answers for a same-currency base occurrence.
      expect(first.amount).toBe(584.59);
    });

    it("hands the count to the expansion", async () => {
      const result = await service.projectLoanOccurrences(
        userId,
        scheduledTransactionId,
        2,
      );
      expect(result.occurrences.map((o) => o.dueDate)).toEqual([
        "2023-02-03",
        "2023-03-03",
      ]);
    });

    it("matches each occurrence to its override through the expander and names it", async () => {
      overridesRepository.find.mockResolvedValue([
        {
          id: "ovr-march",
          scheduledTransactionId,
          originalDate: "2023-03-03",
          overrideDate: "2023-03-03",
          amount: -610,
          splits: null,
        },
      ]);
      const result = await service.projectLoanOccurrences(
        userId,
        scheduledTransactionId,
        2,
      );
      expect(result.occurrences[1]).toMatchObject({
        overrideId: "ovr-march",
        amount: 610,
        interest: 415.97,
        principal: 194.03,
      });
      expect(overridesRepository.find).toHaveBeenCalledWith({
        where: { scheduledTransactionId },
      });
    });

    it("is not found for a schedule that is not the caller's", async () => {
      scheduledTransactionsRepository.findOne.mockResolvedValue(null);
      await expect(
        service.projectLoanOccurrences(userId, scheduledTransactionId, 5),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("answers not-a-loan, with no rows, when no line transfers to a loan-like account", async () => {
      accountsRepository.findOne.mockResolvedValue(
        makeLoanAccount({ accountType: "CHECKING" as AccountType }),
      );
      const result = await service.projectLoanOccurrences(
        userId,
        scheduledTransactionId,
        5,
      );
      expect(result).toEqual({
        scheduledTransactionId,
        loanAccountId: null,
        status: "not-a-loan",
        currencyCode: "CAD",
        occurrences: [],
      });
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("answers declined, with no rows, for a loan template the core does not price", async () => {
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        mortgageSchedule({
          splits: [
            {
              id: "split-principal",
              transferAccountId: loanAccountId,
              categoryId: null,
              amount: -167.92,
              memo: "Principal",
            },
            {
              id: "split-interest",
              transferAccountId: null,
              categoryId: "cat-interest",
              amount: -416.67,
              memo: "Interest",
            },
            {
              id: "split-escrow",
              transferAccountId: null,
              categoryId: "cat-escrow",
              amount: -50,
              memo: "Escrow",
            },
          ],
        } as Partial<ScheduledTransaction>),
      );
      const result = await service.projectLoanOccurrences(
        userId,
        scheduledTransactionId,
        5,
      );
      expect(result).toMatchObject({
        loanAccountId,
        status: "declined",
        occurrences: [],
      });
    });

    it("has no occurrence to price on an inactive schedule", async () => {
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        mortgageSchedule({ isActive: false }),
      );
      const result = await service.projectLoanOccurrences(
        userId,
        scheduledTransactionId,
        5,
      );
      expect(result).toMatchObject({ status: "priced", occurrences: [] });
      expect(overridesRepository.find).not.toHaveBeenCalled();
    });

    it("answers declined, with no rows, for a foreign-currency schedule, which the posting does not re-price", async () => {
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        mortgageSchedule({
          originalCurrencyCode: "USD",
          originalAmount: -430,
        } as Partial<ScheduledTransaction>),
      );
      const result = await service.projectLoanOccurrences(
        userId,
        scheduledTransactionId,
        5,
      );
      expect(result).toEqual({
        scheduledTransactionId,
        loanAccountId,
        status: "declined",
        currencyCode: "CAD",
        occurrences: [],
      });
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("walks the chain through a cursor an override moved past the count, and reads the ledger at its dates too", async () => {
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        mortgageSchedule({ amount: -560 } as Partial<ScheduledTransaction>),
      );
      overridesRepository.find.mockResolvedValue([
        {
          id: "ovr-cursor",
          scheduledTransactionId,
          originalDate: "2023-02-03",
          overrideDate: "2023-06-10",
          amount: null,
          splits: null,
        },
      ]);
      const result = await service.projectLoanOccurrences(
        userId,
        scheduledTransactionId,
        2,
      );
      // The cursor bills the stored 560.00 when it posts on 2023-06-10; the
      // two slots before that date bill the advancement.
      expect(
        result.occurrences.map((o) => [o.originalDate, o.dueDate, o.amount]),
      ).toEqual([
        ["2023-03-03", "2023-03-03", 584.59],
        ["2023-04-03", "2023-04-03", 584.59],
      ]);
      const ledgerCalls = manager.query.mock.calls.filter(([sql]) =>
        String(sql).includes("unnest"),
      );
      expect(ledgerCalls).toHaveLength(1);
      expect(ledgerCalls[0][1]?.[2]).toEqual(
        expect.arrayContaining(["2023-02-03", "2023-06-10"]),
      );
    });

    it("refuses, rather than guesses, when the ledger cannot be read (8.4)", async () => {
      ledgerAt(null);
      await expect(
        service.projectLoanOccurrences(userId, scheduledTransactionId, 5),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    describe("projectLoanOccurrencesMany (spec 8.7)", () => {
      it("answers the same projection as the single read, keyed by schedule", async () => {
        const many = await service.projectLoanOccurrencesMany(userId, [
          { scheduledTransactionId, count: 5 },
        ]);
        const single = await service.projectLoanOccurrences(
          userId,
          scheduledTransactionId,
          5,
        );

        expect(many.get(scheduledTransactionId)).toEqual(single);
        expect(
          many.get(scheduledTransactionId)?.occurrences.map((o) => o.amount),
        ).toEqual([584.59, 584.59, 584.59, 560, 560]);
      });

      it("answers null for a loan whose ledger cannot be read, rather than failing every schedule's read", async () => {
        ledgerAt(null);
        const many = await service.projectLoanOccurrencesMany(userId, [
          { scheduledTransactionId, count: 5 },
        ]);

        expect(many.has(scheduledTransactionId)).toBe(true);
        expect(many.get(scheduledTransactionId)).toBeNull();
      });

      it("reads nothing when asked for nothing", async () => {
        const many = await service.projectLoanOccurrencesMany(userId, []);

        expect(many.size).toBe(0);
        expect(scheduledTransactionsRepository.findOne).not.toHaveBeenCalled();
      });
    });
  });
});
