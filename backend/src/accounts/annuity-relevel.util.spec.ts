import { EntityManager } from "typeorm";
import { Account } from "./entities/account.entity";
import { datedAnnuityInstallment } from "./annuity-relevel.util";
import { recalculateMortgageAfterRateChange } from "./mortgage-amortization.util";

describe("datedAnnuityInstallment remaining term", () => {
  const DEBT = 200000;
  let posted = true;
  /** When set, the postings table holds exactly these original due dates. */
  let postingDates: string[] | null = null;
  /** Dates of non-VOID payment rows on the loan account in the ledger. */
  let ledgerPayments: string[] = [];
  const manager = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes("FROM transactions t")) {
        const [, , through, after] = params as [
          string,
          string,
          string,
          string | null,
        ];
        return ledgerPayments.some(
          (date) => date <= through && (after === null || date > after),
        )
          ? [{ "?column?": 1 }]
          : [];
      }
      if (!sql.includes("scheduled_transaction_postings")) {
        return [{ balance: String(-DEBT) }];
      }
      if (postingDates) {
        const [, through, after] = params as [string, string, string | null];
        return postingDates.some(
          (date) => date <= through && (after === null || date > after),
        )
          ? [{ "?column?": 1 }]
          : [];
      }
      return posted ? [{ "?column?": 1 }] : [];
    }),
  } as unknown as EntityManager;
  beforeEach(() => {
    posted = true;
    postingDates = null;
    ledgerPayments = [];
  });

  const account = (overrides: Partial<Account>): Account =>
    ({
      id: "loan-1",
      userId: "user-1",
      mortgageType: "ANNUITY",
      paymentFrequency: "MONTHLY",
      paymentStartDate: "2024-01-01",
      scheduledTransactionId: "st-1",
      amortizationMonths: 300,
      ...overrides,
    }) as unknown as Account;

  const expected = (months: number) =>
    recalculateMortgageAfterRateChange(DEBT, 5, months, "MONTHLY", "ANNUITY")
      .paymentAmount;

  it("leaves one period fewer when the payment on the effective date is posted", async () => {
    // Payments 1..3 fall on 01-01, 02-01, 03-01: all in the debt, 297 remain.
    const payment = await datedAnnuityInstallment(
      manager,
      account({}),
      5,
      "2024-03-01",
    );
    expect(payment).toBe(expected(297));
    expect(payment).not.toBe(expected(298));
  });

  it("finds a posting whose date was clamped or moved within the period", async () => {
    // Calendar of month-ends from 2024-01-31; the occurrence for the payment
    // due 2024-04-30 was posted under 2024-04-29. An exact-date match missed
    // it and counted the payment as still to come.
    postingDates = ["2024-03-29", "2024-04-29"];
    const monthEnd = account({
      paymentStartDate: "2024-01-31" as unknown as Date,
    });
    expect(
      await datedAnnuityInstallment(manager, monthEnd, 5, "2024-04-30"),
    ).toBe(expected(296));
    // Only the previous period's posting: this one is not in the debt yet.
    postingDates = ["2024-03-29"];
    expect(
      await datedAnnuityInstallment(manager, monthEnd, 5, "2024-04-30"),
    ).toBe(expected(297));
  });

  it("counts the payment due on the date as remaining when it is not posted yet", async () => {
    // Rate change recorded in advance: payment 3 (03-01) is not in the debt.
    posted = false;
    const payment = await datedAnnuityInstallment(
      manager,
      account({}),
      5,
      "2024-03-01",
    );
    expect(payment).toBe(expected(298));
    expect(payment).not.toBe(expected(297));
  });

  it("does not re-amortize 5 remaining months over a 12-month floor", async () => {
    // 14-month term, 11 payments through 2024-11-01: 3 remain.
    const payment = await datedAnnuityInstallment(
      manager,
      account({ amortizationMonths: 14 }),
      5,
      "2024-11-01",
    );
    expect(payment).toBe(expected(3));
    expect(payment).not.toBe(expected(12));
  });

  it("counts a manual payment on a loan with no schedule from the ledger", async () => {
    // No scheduled transaction: only the ledger can say payment 3 was made.
    ledgerPayments = ["2024-03-01"];
    const unscheduled = account({ scheduledTransactionId: null });
    const payment = await datedAnnuityInstallment(
      manager,
      unscheduled,
      5,
      "2024-03-01",
    );
    expect(payment).toBe(expected(297));
    expect(payment).not.toBe(expected(298));
  });

  it("does not count a ledger payment from before the window", async () => {
    // 02-01 belongs to payment 2; payment 3 (03-01) is still to come.
    ledgerPayments = ["2024-02-01"];
    const unscheduled = account({ scheduledTransactionId: null });
    expect(
      await datedAnnuityInstallment(manager, unscheduled, 5, "2024-03-01"),
    ).toBe(expected(298));
  });
});
