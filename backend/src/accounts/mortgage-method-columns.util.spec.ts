import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Account, AccountType } from "./entities/account.entity";
import { LoanRateChange } from "../loan-rate-changes/entities/loan-rate-change.entity";
import { calculatePaymentAmount } from "./mortgage-amortization.util";
import { applyMortgageMethodColumns } from "./mortgage-method-columns.util";
import { MortgageType, PrepaymentMode } from "./mortgage-type.util";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { ACCOUNT_BALANCE_AS_OF_SQL } from "../common/ledger-balance.sql";

/**
 * The columns an account update writes beside the mortgage type
 * (docs/specs/mortgage-types.md, decisions 10 and 11, section 5.6).
 */
describe("applyMortgageMethodColumns", () => {
  const rates = { find: jest.fn() };
  let manager: Record<string, jest.Mock>;

  const makeMortgage = (overrides: Partial<Account> = {}): Account =>
    ({
      id: "mortgage-1",
      userId: "user-1",
      accountType: AccountType.MORTGAGE,
      mortgageType: "LINEAR",
      prepaymentMode: null,
      interestRate: 2,
      paymentAmount: null,
      paymentFrequency: "MONTHLY",
      paymentStartDate: "2024-01-01",
      amortizationMonths: 360,
      originalPrincipal: 300000,
      openingBalance: -300000,
      scheduledTransactionId: "sched-1",
      ...overrides,
    }) as unknown as Account;

  beforeEach(() => {
    jest.clearAllMocks();
    ({ manager } = createScopedDbMocks([[LoanRateChange, rates]]));
    rates.find.mockResolvedValue([
      { effectiveDate: "2024-01-01", annualRate: "2" },
      { effectiveDate: "2027-01-01", annualRate: "4" },
    ]);
    manager.query.mockImplementation(async (sql: string) =>
      sql === ACCOUNT_BALANCE_AS_OF_SQL
        ? [{ balance: "-235000.0012" }]
        : [{ next_due_date: "2027-01-01" }],
    );
  });

  const apply = (
    account: Account,
    previousType: MortgageType | null,
    mode?: PrepaymentMode | null,
    previousMode: PrepaymentMode | null = null,
  ) =>
    applyMortgageMethodColumns(
      manager as unknown as EntityManager,
      account,
      { type: previousType, mode: previousMode },
      mode,
    );

  it("clears both columns' method state off a non-mortgage", async () => {
    const account = makeMortgage({
      accountType: AccountType.LOAN,
      mortgageType: "ANNUITY",
      prepaymentMode: "LOWER_INSTALLMENT",
      paymentAmount: 500,
    });
    await apply(account, null, "LOWER_INSTALLMENT");
    expect(account.prepaymentMode).toBeNull();
    expect(account.paymentAmount).toBe(500);
  });

  it("stores the requested mode on a LINEAR mortgage, else keeps the stored one", async () => {
    const account = makeMortgage();
    await apply(account, "LINEAR", "LOWER_INSTALLMENT");
    expect(account.prepaymentMode).toBe("LOWER_INSTALLMENT");

    await apply(account, "LINEAR", undefined);
    expect(account.prepaymentMode).toBe("LOWER_INSTALLMENT");
  });

  it("nulls the payment of a mortgage moved to LINEAR, whatever the form resent", async () => {
    const account = makeMortgage({ paymentAmount: 1108.8584 });
    await apply(account, "ANNUITY", "SHORTEN_TERM");
    expect(account.paymentAmount).toBeNull();
    expect(account.prepaymentMode).toBe("SHORTEN_TERM");
  });

  it("nulls the mode of a mortgage moved off LINEAR", async () => {
    const account = makeMortgage({
      mortgageType: "INTEREST_ONLY",
      prepaymentMode: "LOWER_INSTALLMENT",
    });
    await apply(account, "LINEAR", "LOWER_INSTALLMENT");
    expect(account.prepaymentMode).toBeNull();
    expect(account.paymentAmount).toBeNull();
  });

  it("refuses a LINEAR mortgage without its amortization", async () => {
    await expect(
      apply(makeMortgage({ amortizationMonths: null }), "ANNUITY"),
    ).rejects.toThrow(BadRequestException);
  });

  it("gives a mortgage moved back to an annuity type its re-levelled payment", async () => {
    const account = makeMortgage({ mortgageType: "ANNUITY" });
    const result = await apply(account, "LINEAR");
    expect(result).toEqual({ repriceTemplate: true });

    // The annuity of the debt through the next due date, over the 324 months
    // left of the amortization, at the 4% in force on that date.
    expect(manager.query).toHaveBeenCalledWith(ACCOUNT_BALANCE_AS_OF_SQL, [
      "mortgage-1",
      "user-1",
      "2027-01-01",
    ]);
    expect(account.paymentAmount).toBe(
      calculatePaymentAmount(235000.0012, 4 / 100 / 12, 324),
    );
    expect(account.prepaymentMode).toBeNull();
  });

  it("leaves the payment of a save between two annuity types as the request set it", async () => {
    const account = makeMortgage({
      mortgageType: "CANADIAN_FIXED",
      paymentAmount: 1200,
    });
    const result = await apply(account, "ANNUITY");
    expect(account.paymentAmount).toBe(1200);
    expect(manager.query).not.toHaveBeenCalled();
    // Same method: the template is not repriced, as before.
    expect(result).toEqual({ repriceTemplate: false });
  });

  it("keeps the standing extra inside the re-levelled payment", async () => {
    // payment_amount is the whole installment, extra included
    // (basePayment = payment_amount - extra in resolveInstallment).
    const account = makeMortgage({
      mortgageType: "ANNUITY",
      extraPaymentAmount: 100,
    });
    await apply(account, "INTEREST_ONLY");
    expect(account.paymentAmount).toBe(
      calculatePaymentAmount(235000.0012, 4 / 100 / 12, 324) + 100,
    );
  });

  it("refuses to re-level at a defaulted 0% when no rate is known", async () => {
    rates.find.mockResolvedValue([]);
    const account = makeMortgage({
      mortgageType: "ANNUITY",
      interestRate: null,
    });
    await expect(apply(account, "LINEAR")).rejects.toThrow(
      /requires interestRate/,
    );
  });

  it("asks for a template reprice when the method or a LINEAR mode changes", async () => {
    expect(await apply(makeMortgage(), "ANNUITY")).toEqual({
      repriceTemplate: true,
    });
    expect(
      await apply(
        makeMortgage({ prepaymentMode: "SHORTEN_TERM" }),
        "LINEAR",
        "LOWER_INSTALLMENT",
        "SHORTEN_TERM",
      ),
    ).toEqual({ repriceTemplate: true });
    expect(
      await apply(makeMortgage(), "LINEAR", undefined, "SHORTEN_TERM"),
    ).toEqual({ repriceTemplate: false });
    expect(
      await apply(makeMortgage({ accountType: AccountType.LOAN }), "LINEAR"),
    ).toEqual({ repriceTemplate: false });
  });
});
