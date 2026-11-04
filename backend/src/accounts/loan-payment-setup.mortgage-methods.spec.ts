import { LoanFee } from "../loan-fees/entities/loan-fee.entity";

import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

/** The mortgage fees a case configures; none unless it says otherwise. */
const loanFeesMock = { find: jest.fn() };
beforeEach(() => loanFeesMock.find.mockReset().mockResolvedValue([]));

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { LoanPaymentSetupService } from "./loan-payment-setup.service";
import { LoanPaymentMatchingService } from "./loan-payment-matching.service";
import { Account, AccountType } from "./entities/account.entity";
import { Category } from "../categories/entities/category.entity";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { ACCOUNT_BALANCE_AS_OF_SQL } from "../common/ledger-balance.sql";
import { SetupLoanPaymentsDto } from "./dto/setup-loan-payments.dto";
import { constantLinearPrincipal } from "./mortgage-installment.util";

/**
 * Payment setup for LINEAR and INTEREST_ONLY mortgages
 * (docs/specs/mortgage-types.md, sections 5.5, 5.6 and 9): the server prices
 * the first installment from table 4.3 on the ledger debt through the first due
 * date, refuses a request whose payment disagrees with it, and stores no
 * constant payment. EUR 300,000 over 360 monthly payments at 2.00%.
 */
describe("LoanPaymentSetupService: LINEAR and INTEREST_ONLY", () => {
  let service: LoanPaymentSetupService;
  let accountsRepository: Record<string, jest.Mock>;
  let scheduledTransactionsService: Record<string, jest.Mock>;
  let paymentMatching: jest.Mocked<
    Pick<
      LoanPaymentMatchingService,
      "assertDefinable" | "createMatchingRuleReported"
    >
  >;
  let manager: ManagerMock;

  const mortgage = {
    id: "mortgage-1",
    userId: "user-1",
    name: "Hypotheek",
    accountType: AccountType.MORTGAGE,
    currencyCode: "EUR",
    currentBalance: -300000,
    openingBalance: -300000,
    interestRate: 2,
    institution: "ING",
    scheduledTransactionId: null,
    mortgageType: "ANNUITY",
    prepaymentMode: null,
    originalPrincipal: 300000,
    amortizationMonths: 360,
  };

  const source = {
    id: "source-1",
    userId: "user-1",
    name: "Checking",
    accountType: AccountType.CHEQUING,
    currencyCode: "EUR",
  };

  const dto = (
    overrides: Partial<SetupLoanPaymentsDto> = {},
  ): SetupLoanPaymentsDto => ({
    paymentAmount: 1333.3333,
    paymentFrequency: "MONTHLY",
    sourceAccountId: "source-1",
    nextDueDate: "2024-01-01",
    mortgageType: "LINEAR",
    amortizationMonths: 360,
    interestCategoryId: "interest-cat-1",
    ...overrides,
  });

  const setUp = (account: Record<string, unknown> = mortgage) => {
    accountsRepository.findOne
      .mockResolvedValueOnce(account)
      .mockResolvedValueOnce(source);
  };

  beforeEach(async () => {
    paymentMatching = {
      assertDefinable: jest.fn(),
      createMatchingRuleReported: jest
        .fn()
        .mockResolvedValue({ ruleId: "rule-1", error: null }),
    };
    accountsRepository = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    scheduledTransactionsService = {
      create: jest.fn().mockResolvedValue({ id: "sched-1" }),
    };
    const mocks = createScopedDbMocks([
      [LoanFee, loanFeesMock],
      [Account, accountsRepository],
      [
        Category,
        {
          findOne: jest
            .fn()
            .mockImplementation(({ where }: any) =>
              Promise.resolve({ id: where.id, userId: where.userId }),
            ),
        },
      ],
    ]);
    manager = mocks.manager;
    manager.query.mockResolvedValue([{ balance: "-300000" }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanPaymentSetupService,
        { provide: DataSource, useValue: mocks.dataSource },
        {
          provide: ScheduledTransactionsService,
          useValue: scheduledTransactionsService,
        },
        { provide: LoanPaymentMatchingService, useValue: paymentMatching },
      ],
    }).compile();
    service = module.get(LoanPaymentSetupService);
  });

  it("prices a LINEAR first installment from the ledger and stores no payment", async () => {
    setUp();

    const result = await service.setupLoanPayments(
      "user-1",
      "mortgage-1",
      dto(),
    );

    expect(manager.query).toHaveBeenCalledWith(ACCOUNT_BALANCE_AS_OF_SQL, [
      "mortgage-1",
      "user-1",
      "2024-01-01",
    ]);
    const created = scheduledTransactionsService.create.mock.calls[0][1];
    expect(created.amount).toBe(-1333.3333);
    expect(created.splits).toEqual([
      {
        transferAccountId: "mortgage-1",
        amount: -833.3333,
        memo: "Principal",
      },
      { categoryId: "interest-cat-1", amount: -500, memo: "Interest" },
    ]);
    const update = accountsRepository.update.mock.calls[0][1];
    expect(update).toMatchObject({
      paymentAmount: null,
      mortgageType: "LINEAR",
      prepaymentMode: null,
      paymentStartDate: expect.any(Date),
    });
    expect(result.firstInstallmentAmount).toBe(1333.3333);
  });

  it("prices c from the originalPrincipal it stores when that differs from the opening balance, preview and setup alike", async () => {
    // A loan of 300,000 whose ledger opens at 260,000 (docs/specs/
    // loan-installment-settlement.md section 14.3).
    const underway = {
      ...mortgage,
      openingBalance: -260000,
      currentBalance: -260000,
      originalPrincipal: null,
    };
    manager.query.mockResolvedValue([{ balance: "-260000" }]);
    const c = constantLinearPrincipal({
      originalPrincipal: 300000,
      openingBalance: -260000,
      amortizationMonths: 360,
      paymentFrequency: "MONTHLY",
    });
    expect(c).toBe(833.3333);

    accountsRepository.findOne.mockResolvedValueOnce(underway);
    const preview = await service.previewFirstInstallment(
      "user-1",
      "mortgage-1",
      {
        paymentFrequency: "MONTHLY",
        nextDueDate: "2024-01-01",
        mortgageType: "LINEAR",
        amortizationMonths: 360,
        originalPrincipal: 300000,
      },
    );
    expect(preview).toEqual({
      derivesInstallment: true,
      principalPayment: c,
      interestPayment: 433.3333,
      paymentAmount: 1266.6666,
    });

    setUp(underway);
    await service.setupLoanPayments(
      "user-1",
      "mortgage-1",
      dto({ paymentAmount: 1266.6666, originalPrincipal: 300000 }),
    );
    const created = scheduledTransactionsService.create.mock.calls[0][1];
    expect(created.splits[0]).toEqual({
      transferAccountId: "mortgage-1",
      amount: -c!,
      memo: "Principal",
    });
    expect(accountsRepository.update.mock.calls[0][1].originalPrincipal).toBe(
      300000,
    );
  });

  it("stores the opening balance as originalPrincipal when neither the request nor the account has one", async () => {
    setUp({ ...mortgage, originalPrincipal: null });
    await service.setupLoanPayments("user-1", "mortgage-1", dto());
    expect(accountsRepository.update.mock.calls[0][1].originalPrincipal).toBe(
      300000,
    );
  });

  it("stores the requested prepayment mode on a LINEAR mortgage", async () => {
    setUp();
    // LOWER_INSTALLMENT's first installment is debt / N: the same 833.3333.
    await service.setupLoanPayments(
      "user-1",
      "mortgage-1",
      dto({ prepaymentMode: "LOWER_INSTALLMENT" }),
    );
    expect(accountsRepository.update.mock.calls[0][1].prepaymentMode).toBe(
      "LOWER_INSTALLMENT",
    );
  });

  it("writes no prepayment mode for any other type", async () => {
    setUp();
    await service.setupLoanPayments(
      "user-1",
      "mortgage-1",
      dto({
        mortgageType: "ANNUITY",
        paymentAmount: 1108.8584,
        prepaymentMode: "LOWER_INSTALLMENT",
      }),
    );
    const update = accountsRepository.update.mock.calls[0][1];
    expect(update.prepaymentMode).toBeNull();
    // An annuity mortgage still stores its constant payment.
    expect(update.paymentAmount).toBe(1108.8584);
  });

  it("keeps the extra principal on its own line, on top of the installment", async () => {
    setUp();
    await service.setupLoanPayments(
      "user-1",
      "mortgage-1",
      dto({ paymentAmount: 1433.3333, extraPrincipal: 100 }),
    );
    const created = scheduledTransactionsService.create.mock.calls[0][1];
    expect(created.amount).toBe(-1433.3333);
    expect(created.splits).toEqual([
      {
        transferAccountId: "mortgage-1",
        amount: -833.3333,
        memo: "Principal",
      },
      { categoryId: "interest-cat-1", amount: -500, memo: "Interest" },
      {
        transferAccountId: "mortgage-1",
        amount: -100,
        memo: "Extra Principal",
      },
    ]);
    expect(accountsRepository.update.mock.calls[0][1].extraPaymentAmount).toBe(
      100,
    );
  });

  it("refuses a payment that differs from the priced installment, writing nothing", async () => {
    setUp();
    await expect(
      service.setupLoanPayments(
        "user-1",
        "mortgage-1",
        dto({ paymentAmount: 1333.34 }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(scheduledTransactionsService.create).not.toHaveBeenCalled();
    expect(accountsRepository.update).not.toHaveBeenCalled();
  });

  it("gives an INTEREST_ONLY template a zero principal line beside the interest", async () => {
    setUp();
    await service.setupLoanPayments(
      "user-1",
      "mortgage-1",
      dto({ mortgageType: "INTEREST_ONLY", paymentAmount: 500 }),
    );
    const created = scheduledTransactionsService.create.mock.calls[0][1];
    expect(created.amount).toBe(-500);
    expect(created.splits).toEqual([
      { transferAccountId: "mortgage-1", amount: -0, memo: "Principal" },
      { categoryId: "interest-cat-1", amount: -500, memo: "Interest" },
    ]);
    expect(accountsRepository.update.mock.calls[0][1].paymentAmount).toBeNull();
  });

  it("refuses a LINEAR mortgage without an amortization, naming it", async () => {
    setUp({ ...mortgage, amortizationMonths: null });
    await expect(
      service.setupLoanPayments(
        "user-1",
        "mortgage-1",
        dto({ amortizationMonths: undefined }),
      ),
    ).rejects.toThrow(/requires amortizationMonths/);
    expect(scheduledTransactionsService.create).not.toHaveBeenCalled();
  });

  it("refuses when the ledger cannot be read, writing nothing", async () => {
    setUp();
    manager.query.mockResolvedValue([]);
    await expect(
      service.setupLoanPayments("user-1", "mortgage-1", dto()),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(scheduledTransactionsService.create).not.toHaveBeenCalled();
  });

  describe("previewFirstInstallment", () => {
    const previewDto = {
      paymentFrequency: "MONTHLY",
      nextDueDate: "2024-01-01",
      mortgageType: "LINEAR" as const,
      amortizationMonths: 360,
    };

    it("prices the first installment the setup will accept, writing nothing", async () => {
      accountsRepository.findOne.mockResolvedValueOnce(mortgage);
      const preview = await service.previewFirstInstallment(
        "user-1",
        "mortgage-1",
        { ...previewDto, extraPrincipal: 100 },
      );
      expect(preview).toEqual({
        derivesInstallment: true,
        principalPayment: 833.3333,
        interestPayment: 500,
        paymentAmount: 1433.3333,
      });
      expect(manager.query).toHaveBeenCalledWith(ACCOUNT_BALANCE_AS_OF_SQL, [
        "mortgage-1",
        "user-1",
        "2024-01-01",
      ]);
      expect(scheduledTransactionsService.create).not.toHaveBeenCalled();
      expect(accountsRepository.update).not.toHaveBeenCalled();

      // The figure previewed is the one the write checks against.
      setUp();
      await service.setupLoanPayments(
        "user-1",
        "mortgage-1",
        dto({ paymentAmount: preview.paymentAmount!, extraPrincipal: 100 }),
      );
      expect(scheduledTransactionsService.create).toHaveBeenCalled();
    });

    it("prices the dated debt of a loan already underway, not the original principal", async () => {
      accountsRepository.findOne.mockResolvedValueOnce(mortgage);
      manager.query.mockResolvedValue([{ balance: "-265000.0006" }]);
      const preview = await service.previewFirstInstallment(
        "user-1",
        "mortgage-1",
        {
          ...previewDto,
          mortgageType: "INTEREST_ONLY",
          nextDueDate: "2025-07-01",
        },
      );
      expect(preview).toMatchObject({
        principalPayment: 0,
        interestPayment: 441.6667,
        paymentAmount: 441.6667,
      });
    });

    it("answers derivesInstallment false for an annuity mortgage", async () => {
      accountsRepository.findOne.mockResolvedValueOnce(mortgage);
      await expect(
        service.previewFirstInstallment("user-1", "mortgage-1", {
          ...previewDto,
          mortgageType: "ANNUITY",
        }),
      ).resolves.toEqual({
        derivesInstallment: false,
        principalPayment: null,
        interestPayment: null,
        paymentAmount: null,
      });
      expect(manager.query).not.toHaveBeenCalled();
    });

    it("reads the stored type when the request names none", async () => {
      accountsRepository.findOne.mockResolvedValueOnce({
        ...mortgage,
        mortgageType: "LINEAR",
      });
      const preview = await service.previewFirstInstallment(
        "user-1",
        "mortgage-1",
        { ...previewDto, mortgageType: undefined },
      );
      expect(preview.derivesInstallment).toBe(true);
    });

    it("refuses a missing term with the setup's own message", async () => {
      accountsRepository.findOne.mockResolvedValueOnce({
        ...mortgage,
        amortizationMonths: null,
      });
      await expect(
        service.previewFirstInstallment("user-1", "mortgage-1", {
          ...previewDto,
          amortizationMonths: undefined,
        }),
      ).rejects.toThrow(/requires amortizationMonths/);
    });

    it("answers 404 for an account the user does not own", async () => {
      accountsRepository.findOne.mockResolvedValueOnce(null);
      await expect(
        service.previewFirstInstallment("user-1", "mortgage-1", previewDto),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
