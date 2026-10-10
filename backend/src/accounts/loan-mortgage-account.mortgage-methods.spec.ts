import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import {
  createScopedDbMocks,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);
import { BadRequestException } from "@nestjs/common";
import { LoanMortgageAccountService } from "./loan-mortgage-account.service";
import { Account, AccountType } from "./entities/account.entity";
import { Institution } from "../institutions/entities/institution.entity";
import { CategoriesService } from "../categories/categories.service";
import { ScheduledTransactionsService } from "../scheduled-transactions/scheduled-transactions.service";
import { LoanRateChangesService } from "../loan-rate-changes/loan-rate-changes.service";
import { LoanPaymentDetectorService } from "./loan-payment-detector.service";
import { LoanPaymentMatchingService } from "./loan-payment-matching.service";
import { CreateAccountDto } from "./dto/create-account.dto";
import { constantLinearPrincipal } from "./mortgage-installment.util";

/**
 * Creating a LINEAR or INTEREST_ONLY mortgage, and the mortgage rate update
 * for one (docs/specs/mortgage-types.md, sections 5.1, 5.3 and 5.6): the
 * account stores no constant payment, its template starts at the first
 * installment, and a rate update states no payment.
 */
describe("LoanMortgageAccountService: LINEAR and INTEREST_ONLY", () => {
  let service: LoanMortgageAccountService;
  let accountsRepository: Record<string, jest.Mock>;
  let scheduledTransactionsService: Record<string, jest.Mock>;
  let loanRateChangesService: Record<string, jest.Mock>;
  let manager: ManagerMock;

  const userId = "user-1";

  const makeDto = (overrides: Record<string, unknown> = {}): CreateAccountDto =>
    ({
      accountType: AccountType.MORTGAGE,
      name: "Hypotheek",
      currencyCode: "EUR",
      openingBalance: 300000,
      mortgagePaymentFrequency: "MONTHLY",
      paymentStartDate: "2024-01-01",
      sourceAccountId: "acc-chequing",
      interestRate: 2,
      institution: "ING",
      amortizationMonths: 360,
      mortgageType: "LINEAR",
      ...overrides,
    }) as unknown as CreateAccountDto;

  const makeMortgage = (overrides: Partial<Account> = {}): Account =>
    ({
      id: "mortgage-1",
      userId,
      accountType: AccountType.MORTGAGE,
      mortgageType: "LINEAR",
      prepaymentMode: null,
      isCanadianMortgage: false,
      isVariableRate: false,
      isClosed: false,
      interestRate: 2,
      paymentAmount: null,
      paymentFrequency: "MONTHLY",
      paymentStartDate: "2024-01-01",
      amortizationMonths: 360,
      originalPrincipal: 300000,
      openingBalance: -300000,
      ...overrides,
    }) as unknown as Account;

  beforeEach(async () => {
    accountsRepository = {
      create: jest.fn().mockImplementation((data: any) => ({
        id: "new-acc-id",
        ...data,
      })),
      save: jest
        .fn()
        .mockImplementation((entity: any) => Promise.resolve(entity)),
      findOne: jest.fn().mockResolvedValue(null),
    };
    scheduledTransactionsService = {
      create: jest.fn().mockResolvedValue({ id: "sched-tx-1" }),
    };
    loanRateChangesService = {
      create: jest.fn().mockImplementation((_userId, _accountId, dto) =>
        Promise.resolve({
          id: "rate-change-1",
          effectiveDate: dto.effectiveDate,
          annualRate: dto.annualRate,
          newPaymentAmount: null,
          source: "manual",
        }),
      ),
      applyScheduledPaymentSync: jest.fn().mockResolvedValue(null),
    };

    const mocks = createScopedDbMocks([
      [Account, accountsRepository],
      [Institution, { findOne: jest.fn().mockResolvedValue(null) }],
    ]);
    manager = mocks.manager;
    manager.query.mockResolvedValue([{ balance: "-235000.0012" }]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoanMortgageAccountService,
        { provide: DataSource, useValue: mocks.dataSource },
        {
          provide: CategoriesService,
          useValue: {
            findLoanCategories: jest.fn().mockResolvedValue({
              interestCategory: { id: "cat-interest" },
            }),
          },
        },
        {
          provide: ScheduledTransactionsService,
          useValue: scheduledTransactionsService,
        },
        { provide: LoanRateChangesService, useValue: loanRateChangesService },
        { provide: LoanPaymentDetectorService, useValue: {} },
        { provide: LoanPaymentMatchingService, useValue: {} },
      ],
    }).compile();
    service = module.get(LoanMortgageAccountService);
  });

  describe("createMortgageAccount", () => {
    it("stores no payment for a LINEAR mortgage and starts the template at the first installment", async () => {
      await service.createMortgageAccount(
        userId,
        makeDto({ prepaymentMode: "LOWER_INSTALLMENT" }),
      );

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentAmount: null,
          mortgageType: "LINEAR",
          prepaymentMode: "LOWER_INSTALLMENT",
          isCanadianMortgage: false,
          originalPrincipal: 300000,
          amortizationMonths: 360,
        }),
      );
      const template = scheduledTransactionsService.create.mock.calls[0][1];
      expect(template.amount).toBe(-1333.3333);
      expect(template.endDate).toBe("2053-12-01");
      expect(template.splits).toEqual([
        {
          transferAccountId: "new-acc-id",
          amount: -833.3333,
          memo: "Principal",
        },
        { categoryId: "cat-interest", amount: -500, memo: "Interest" },
      ]);
    });

    it("keeps an INTEREST_ONLY template's principal line at zero", async () => {
      await service.createMortgageAccount(
        userId,
        makeDto({
          mortgageType: "INTEREST_ONLY",
          prepaymentMode: "LOWER_INSTALLMENT",
        }),
      );

      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentAmount: null,
          mortgageType: "INTEREST_ONLY",
          // Only LINEAR keeps a mode, whatever the request carries.
          prepaymentMode: null,
        }),
      );
      const template = scheduledTransactionsService.create.mock.calls[0][1];
      expect(template.amount).toBe(-500);
      expect(template.splits[0]).toEqual({
        transferAccountId: "new-acc-id",
        amount: -0,
        memo: "Principal",
      });
    });

    it("still stores an annuity mortgage's payment, with no mode", async () => {
      await service.createMortgageAccount(
        userId,
        makeDto({ mortgageType: "ANNUITY", prepaymentMode: "SHORTEN_TERM" }),
      );
      expect(accountsRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentAmount: 1108.8584,
          prepaymentMode: null,
        }),
      );
    });

    it("prices a LINEAR constant principal from originalPrincipal, not the opening balance, when they differ", async () => {
      // A loan of 300,000 whose ledger opens at 260,000 (docs/specs/
      // loan-installment-settlement.md section 14.3): c is 300,000 / 360,
      // interest is on the 260,000 owed.
      await service.createMortgageAccount(
        userId,
        makeDto({ openingBalance: 260000, originalPrincipal: 300000 }),
      );

      const stored = accountsRepository.create.mock.calls[0][0];
      expect(stored).toMatchObject({
        openingBalance: -260000,
        originalPrincipal: 300000,
      });
      const c = constantLinearPrincipal(stored);
      expect(c).toBe(833.3333);
      const template = scheduledTransactionsService.create.mock.calls[0][1];
      expect(template.splits).toEqual([
        { transferAccountId: "new-acc-id", amount: -c!, memo: "Principal" },
        {
          categoryId: "cat-interest",
          amount: -433.3333,
          memo: "Interest",
        },
      ]);
      expect(template.amount).toBe(-1266.6666);
      // Not the opening balance over the count (722.2222).
      expect(
        constantLinearPrincipal({ ...stored, originalPrincipal: null }),
      ).toBe(722.2222);
    });

    it("stores the opening balance as originalPrincipal when the request names none", async () => {
      await service.createMortgageAccount(
        userId,
        makeDto({ openingBalance: 260000 }),
      );

      const stored = accountsRepository.create.mock.calls[0][0];
      expect(stored.originalPrincipal).toBe(260000);
      expect(
        scheduledTransactionsService.create.mock.calls[0][1].splits[0].amount,
      ).toBe(-constantLinearPrincipal(stored)!);
      expect(constantLinearPrincipal(stored)).toBe(722.2222);
    });

    it("refuses an accelerated LINEAR mortgage before writing anything", async () => {
      await expect(
        service.createMortgageAccount(
          userId,
          makeDto({ mortgagePaymentFrequency: "ACCELERATED_BIWEEKLY" }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(accountsRepository.save).not.toHaveBeenCalled();
      expect(scheduledTransactionsService.create).not.toHaveBeenCalled();
    });
  });

  describe("updateMortgageRate", () => {
    it("refuses a stated payment for a LINEAR mortgage before recording anything", async () => {
      await expect(
        service.updateMortgageRate(
          makeMortgage(),
          userId,
          4,
          new Date("2027-01-01"),
          1600,
        ),
      ).rejects.toThrow(/cannot state a payment amount/);
      expect(loanRateChangesService.create).not.toHaveBeenCalled();
    });

    it("answers the method's installment at the effective date (spec 5.3)", async () => {
      const result = await service.updateMortgageRate(
        makeMortgage(),
        userId,
        4,
        new Date("2027-01-01"),
      );

      expect(loanRateChangesService.create).toHaveBeenCalledWith(
        userId,
        "mortgage-1",
        expect.objectContaining({
          effectiveDate: "2027-01-01",
          annualRate: 4,
          newPaymentAmount: null,
        }),
      );
      expect(result).toEqual({
        newRate: 4,
        paymentAmount: 1616.6666,
        principalPayment: 833.3333,
        interestPayment: 783.3333,
        effectiveDate: "2027-01-01",
      });
    });

    it("applies the sync through the rate-change service's apply and writes nothing on the account", async () => {
      await service.updateMortgageRate(
        makeMortgage(),
        userId,
        4,
        new Date("2027-01-01"),
      );

      expect(
        loanRateChangesService.applyScheduledPaymentSync,
      ).toHaveBeenCalledWith(userId, "mortgage-1");
      expect(accountsRepository.save).not.toHaveBeenCalled();
    });

    it("answers the interest alone for an INTEREST_ONLY mortgage", async () => {
      manager.query.mockResolvedValue([{ balance: "-265000" }]);
      const result = await service.updateMortgageRate(
        makeMortgage({ mortgageType: "INTEREST_ONLY" }),
        userId,
        4,
        new Date("2027-01-01"),
      );
      expect(result).toMatchObject({
        paymentAmount: 883.3333,
        principalPayment: 0,
        interestPayment: 883.3333,
      });
    });

    it("refuses a LINEAR mortgage missing its amortization", async () => {
      await expect(
        service.updateMortgageRate(
          makeMortgage({ amortizationMonths: null }),
          userId,
          4,
          new Date("2027-01-01"),
        ),
      ).rejects.toThrow(/requires amortizationMonths/);
      expect(loanRateChangesService.create).not.toHaveBeenCalled();
    });
  });
});
