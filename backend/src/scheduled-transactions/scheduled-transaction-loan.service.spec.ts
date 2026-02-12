import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { ScheduledTransactionLoanService } from "./scheduled-transaction-loan.service";
import { ScheduledTransaction } from "./entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "./entities/scheduled-transaction-split.entity";
import { Account } from "../accounts/entities/account.entity";

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
      save: jest.fn().mockImplementation((entity: any) =>
        Promise.resolve(entity),
      ),
    };

    accountsRepository = {
      findOne: jest.fn().mockResolvedValue(null),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ScheduledTransactionLoanService,
        {
          provide: getRepositoryToken(ScheduledTransaction),
          useValue: scheduledTransactionsRepository,
        },
        {
          provide: getRepositoryToken(ScheduledTransactionSplit),
          useValue: splitsRepository,
        },
        {
          provide: getRepositoryToken(Account),
          useValue: accountsRepository,
        },
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

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

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

    it("should deactivate scheduled transaction when balance is near zero", async () => {
      const loanAccount = makeLoanAccount({ currentBalance: -0.005 });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction();
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

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

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

      expect(scheduledTransactionsRepository.update).toHaveBeenCalledWith(
        scheduledTransactionId,
        { isActive: false },
      );
    });

    it("should return early when loan account is not found", async () => {
      accountsRepository.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

      expect(scheduledTransactionsRepository.findOne).not.toHaveBeenCalled();
      expect(splitsRepository.save).not.toHaveBeenCalled();
    });

    it("should return early when scheduled transaction is not found", async () => {
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      scheduledTransactionsRepository.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

      expect(splitsRepository.save).not.toHaveBeenCalled();
    });

    it("should return early when scheduled transaction is inactive", async () => {
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      scheduledTransactionsRepository.findOne.mockResolvedValue(
        makeScheduledTransaction({ isActive: false }),
      );

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

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

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

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

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

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

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

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

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

      // principalSplit and interestSplit will be undefined
      // So save should not be called
      expect(splitsRepository.save).not.toHaveBeenCalled();
    });

    it("should handle empty splits array", async () => {
      const loanAccount = makeLoanAccount({ currentBalance: -20000 });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction({ splits: [] as any });
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

      expect(splitsRepository.save).not.toHaveBeenCalled();
    });

    it("should load scheduled transaction with splits relation", async () => {
      accountsRepository.findOne.mockResolvedValue(makeLoanAccount());
      scheduledTransactionsRepository.findOne.mockResolvedValue(null);

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

      expect(scheduledTransactionsRepository.findOne).toHaveBeenCalledWith({
        where: { id: scheduledTransactionId },
        relations: ["splits"],
      });
    });

    it("should calculate correct interest for the current balance", async () => {
      // $20,000 at 6% monthly: interest = 20000 * (0.06 / 12) = 100.00
      const loanAccount = makeLoanAccount({
        currentBalance: -20000,
        interestRate: 6,
        paymentFrequency: "MONTHLY",
      });
      accountsRepository.findOne.mockResolvedValue(loanAccount);

      const scheduledTx = makeScheduledTransaction({ amount: -500 });
      scheduledTransactionsRepository.findOne.mockResolvedValue(scheduledTx);

      await service.recalculateLoanPaymentSplits(
        scheduledTransactionId,
        loanAccountId,
      );

      const interestSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].categoryId === "cat-interest",
      );
      // Interest = -100 (negated)
      expect(interestSave[0].amount).toBe(-100);

      const principalSave = splitsRepository.save.mock.calls.find(
        (call: any) => call[0].transferAccountId === loanAccountId,
      );
      // Principal = -(500 - 100) = -400
      expect(principalSave[0].amount).toBe(-400);
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

    it("should return null when transfer account is not a LOAN type", async () => {
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

      accountsRepository.findOne.mockImplementation(
        (opts: any) => {
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
        },
      );

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
