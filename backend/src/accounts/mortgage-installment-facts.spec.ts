import { DataSource } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import { ScheduledTransaction } from "../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledOccurrenceService } from "../scheduled-transactions/scheduled-occurrence.service";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { derivedInstallmentFacts } from "./mortgage-installment-facts";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

/**
 * What a reader gets in place of `payment_amount` for a LINEAR or
 * INTEREST_ONLY mortgage (docs/specs/mortgage-types.md, section 5.6).
 */
describe("derivedInstallmentFacts", () => {
  const schedules = { find: jest.fn() };
  const rates = { find: jest.fn() };
  let dataSource: unknown;
  let occurrences: { expand: jest.Mock };

  const makeMortgage = (overrides: Partial<Account> = {}): Account =>
    ({
      id: "mortgage-1",
      userId: "user-1",
      accountType: AccountType.MORTGAGE,
      mortgageType: "INTEREST_ONLY",
      interestRate: 2,
      paymentFrequency: "MONTHLY",
      paymentStartDate: "2024-01-01",
      amortizationMonths: 360,
      scheduledTransactionId: "sched-1",
      ...overrides,
    }) as unknown as Account;

  beforeEach(() => {
    jest.clearAllMocks();
    ({ dataSource } = createScopedDbMocks([
      [ScheduledTransaction, schedules],
      [LoanRateChange, rates],
    ]));
    schedules.find.mockResolvedValue([{ id: "sched-1", splits: [] }]);
    rates.find.mockResolvedValue([
      { accountId: "mortgage-1", effectiveDate: "2024-01-01", annualRate: "2" },
      { accountId: "mortgage-1", effectiveDate: "2027-01-01", annualRate: "4" },
    ]);
    occurrences = {
      expand: jest.fn().mockResolvedValue([
        {
          scheduledTransactionId: "sched-1",
          dueDate: "2027-02-01",
          amount: -883.3333,
        },
      ]),
    };
  });

  const run = (accounts: Account[], debt = 265000) =>
    derivedInstallmentFacts(
      dataSource as DataSource,
      occurrences as unknown as ScheduledOccurrenceService,
      "user-1",
      accounts,
      new Map(accounts.map((a) => [a.id, debt])),
    );

  it("carries the next occurrence and, for INTEREST_ONLY, the bullet on payment N", async () => {
    const facts = await run([makeMortgage()]);

    expect(occurrences.expand).toHaveBeenCalledWith(
      "user-1",
      [{ id: "sched-1", splits: [] }],
      expect.objectContaining({ maxOccurrences: 1 }),
    );
    expect(facts.get("mortgage-1")).toEqual({
      nextInstallment: { dueDate: "2027-02-01", amount: 883.3333 },
      // 265,000 plus a month's interest at the 4% in force on 2053-12-01.
      bullet: { dueDate: "2053-12-01", amount: 265883.3333 },
    });
  });

  it("withholds the bullet when no rate is known, rather than pricing it at 0%", async () => {
    rates.find.mockResolvedValue([]);
    const facts = await run([makeMortgage({ interestRate: null })]);
    expect(facts.get("mortgage-1")?.bullet).toBeNull();
    expect(facts.get("mortgage-1")?.nextInstallment).not.toBeNull();
  });

  it("carries no bullet for LINEAR", async () => {
    const facts = await run([makeMortgage({ mortgageType: "LINEAR" })]);
    expect(facts.get("mortgage-1")?.bullet).toBeNull();
    expect(facts.get("mortgage-1")?.nextInstallment).toEqual({
      dueDate: "2027-02-01",
      amount: 883.3333,
    });
  });

  it("reports an occurrence whose amount is unknown as unknown", async () => {
    occurrences.expand.mockResolvedValue([
      {
        scheduledTransactionId: "sched-1",
        dueDate: "2027-02-01",
        amount: null,
      },
    ]);
    const facts = await run([makeMortgage({ mortgageType: "LINEAR" })]);
    expect(facts.get("mortgage-1")?.nextInstallment).toEqual({
      dueDate: "2027-02-01",
      amount: null,
    });
  });

  it("has no next installment without a scheduled payment", async () => {
    occurrences.expand.mockResolvedValue([]);
    const facts = await run([
      makeMortgage({ mortgageType: "LINEAR", scheduledTransactionId: null }),
    ]);
    expect(schedules.find).not.toHaveBeenCalled();
    expect(facts.get("mortgage-1")?.nextInstallment).toBeNull();
  });

  it("leaves annuity mortgages and other accounts out, reading nothing", async () => {
    const facts = await run([
      makeMortgage({ mortgageType: "ANNUITY" }),
      makeMortgage({ id: "loan-1", accountType: AccountType.LOAN }),
    ]);
    expect(facts.size).toBe(0);
    expect(occurrences.expand).not.toHaveBeenCalled();
  });
});
