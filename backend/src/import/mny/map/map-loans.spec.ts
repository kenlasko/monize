import { randomUUID } from "node:crypto";
import { AccountType } from "../../../accounts/entities/account.entity";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  MappedAccount,
  MappedAccounts,
  MappedBill,
  MappedSplit,
  MappedTransaction,
  MappedTransactions,
} from "../model/mny-import-model";
import { MapLoansInput, mapLoans } from "./map-loans";

/**
 * A Money loan payment is a split in the chequing account: a transfer leg for
 * principal, a category leg for interest, and sometimes an escrow leg too.
 * These specs pin what that shape is allowed to imply -- and, for the escrow
 * case, what it must refuse to imply.
 */

function account(overrides: Partial<MappedAccount> = {}): MappedAccount {
  return {
    key: "acct-1",
    handle: 1,
    name: "Chequing",
    moneyName: "Chequing",
    accountType: AccountType.CHEQUING,
    accountSubType: null,
    currencyCode: "USD",
    openingBalance: 0,
    creditLimit: null,
    closed: false,
    closedDate: null,
    favourite: false,
    excludeFromNetWorth: false,
    description: null,
    linkedKey: null,
    ...overrides,
  };
}

/** Chequing (1) plus a mortgage (9). */
function accountsFixture(extra: readonly MappedAccount[] = []): MappedAccounts {
  const accounts = [
    account(),
    account({
      key: "acct-9",
      handle: 9,
      name: "Mortgage",
      moneyName: "Mortgage",
      accountType: AccountType.MORTGAGE,
    }),
    ...extra,
  ];

  return {
    baseCurrency: "USD",
    currencyCodes: ["USD"],
    accounts,
    keyByHandle: new Map(accounts.map((a) => [a.handle as number, a.key])),
    currencyByHandle: new Map(
      accounts.map((a) => [a.handle as number, a.currencyCode]),
    ),
    skipped: 0,
    warnings: [],
  };
}

function transaction(
  overrides: Partial<MappedTransaction> = {},
): MappedTransaction {
  return {
    id: randomUUID(),
    handle: 1,
    accountKey: "acct-1",
    transactionDate: "2026-07-01",
    amount: -1500,
    currencyCode: "USD",
    exchangeRate: 1,
    status: TransactionStatus.UNRECONCILED,
    payeeHandle: null,
    categoryHandle: null,
    description: null,
    referenceNumber: null,
    isTransfer: false,
    linkedTransactionId: null,
    splits: [],
    collapsedTradeHandle: null,
    tagHandles: [],
    ...overrides,
  };
}

function principalLeg(amount = -1000): MappedSplit {
  return {
    id: randomUUID(),
    kind: SplitKind.TRANSFER,
    categoryHandle: null,
    transferAccountKey: "acct-9",
    linkedTransactionId: randomUUID(),
    investmentHandle: null,
    amount,
    memo: null,
    tagHandles: [],
  };
}

function categoryLeg(categoryHandle: number, amount: number): MappedSplit {
  return {
    id: randomUUID(),
    kind: SplitKind.CATEGORY,
    categoryHandle,
    transferAccountKey: null,
    linkedTransactionId: null,
    investmentHandle: null,
    amount,
    memo: null,
    tagHandles: [],
  };
}

function transactionsFixture(
  transactions: readonly MappedTransaction[],
): MappedTransactions {
  return {
    transactions,
    referencedPayees: new Set(),
    referencedCategories: new Set(),
    referencedTags: new Set(),
    tradeCashLegTagHandles: new Map(),
    transfersLinked: 0,
    skipped: 0,
    deferredInvestments: 0,
    tradeCashLegs: 0,
    investmentCashSources: new Map(),
    warnings: [],
  };
}

function input(overrides: Partial<MapLoansInput> = {}): MapLoansInput {
  return {
    accounts: accountsFixture(),
    transactions: transactionsFixture([]),
    bills: [],
    ...overrides,
  };
}

/** A payment with a principal transfer leg and one interest category leg. */
function splitPayment(interestCategory = 61): MappedTransaction {
  return transaction({
    splits: [principalLeg(), categoryLeg(interestCategory, -500)],
  });
}

describe("mapLoans", () => {
  it("returns nothing when the file has no loan accounts", () => {
    const accounts = accountsFixture();
    const result = mapLoans(
      input({
        accounts: {
          ...accounts,
          accounts: accounts.accounts.filter(
            (a) => a.accountType !== AccountType.MORTGAGE,
          ),
        },
      }),
    );

    expect(result.loans).toEqual([]);
  });

  it("leaves a loan with no payments and no bill entirely alone", () => {
    const result = mapLoans(input());

    expect(result.loans).toEqual([]);
  });

  it("reads a split-booked loan payment as SPLIT interest booking", () => {
    // RateChangeInferenceService reads this: left at AUTO it also pairs
    // standalone interest expenses, double-counting a loan whose interest is
    // only ever a split leg.
    const result = mapLoans(
      input({ transactions: transactionsFixture([splitPayment()]) }),
    );

    expect(result.loans).toHaveLength(1);
    expect(result.loans[0]).toMatchObject({
      accountKey: "acct-9",
      interestBookingMode: "SPLIT",
      interestCategoryHandle: 61,
      sourceAccountKey: "acct-1",
      paymentsObserved: 1,
    });
  });

  it("refuses to name an interest category when an escrow leg is present", () => {
    // Interest and escrow are both category legs and nothing in the file says
    // which is which. Guessing would label escrow as interest and skew every
    // inferred rate, so the field stays unset and the user is told.
    const result = mapLoans(
      input({
        transactions: transactionsFixture([
          transaction({
            splits: [
              principalLeg(),
              categoryLeg(61, -400),
              categoryLeg(62, -100),
            ],
          }),
        ]),
      }),
    );

    expect(result.loans[0].interestCategoryHandle).toBeNull();
    expect(result.loans[0].interestBookingMode).toBe("SPLIT");
    expect(result.warnings).toEqual([
      { code: "loanInterestCategoryUnclear", subject: "Mortgage" },
    ]);
  });

  it("does not claim SPLIT when the loan also receives plain transfers", () => {
    // A plain transfer carries no interest leg, so interest is booked
    // elsewhere; claiming SPLIT would suppress the pairing that recovers it.
    const loanSide = transaction({
      handle: 2,
      accountKey: "acct-9",
      amount: 1000,
    });
    const plain = transaction({
      handle: 3,
      amount: -1000,
      isTransfer: true,
      linkedTransactionId: loanSide.id,
    });

    const result = mapLoans(
      input({
        transactions: transactionsFixture([splitPayment(), plain, loanSide]),
      }),
    );

    expect(result.loans[0].interestBookingMode).toBeNull();
  });

  it("takes the most common source account across payments", () => {
    const accounts = accountsFixture([
      account({ key: "acct-2", handle: 2, name: "Savings" }),
    ]);

    const result = mapLoans(
      input({
        accounts,
        transactions: transactionsFixture([
          splitPayment(),
          splitPayment(),
          transaction({
            accountKey: "acct-2",
            splits: [principalLeg(), categoryLeg(61, -500)],
          }),
        ]),
      }),
    );

    expect(result.loans[0].sourceAccountKey).toBe("acct-1");
    expect(result.loans[0].paymentsObserved).toBe(3);
  });

  it("leaves the source account unset when payments are evenly split", () => {
    const accounts = accountsFixture([
      account({ key: "acct-2", handle: 2, name: "Savings" }),
    ]);

    const result = mapLoans(
      input({
        accounts,
        transactions: transactionsFixture([
          splitPayment(),
          transaction({
            accountKey: "acct-2",
            splits: [principalLeg(), categoryLeg(61, -500)],
          }),
        ]),
      }),
    );

    expect(result.loans[0].sourceAccountKey).toBeNull();
  });

  it("prefers the scheduled bill's amount and cadence over the payment history", () => {
    // The bill is what Money was going to post next; the history is what it
    // posted before the last rate change.
    const bill: MappedBill = {
      handle: 7,
      seriesKey: 7,
      status: 0,
      name: "Mortgage payment",
      accountKey: "acct-1",
      payeeHandle: null,
      categoryHandle: null,
      amount: -1600,
      currencyCode: "USD",
      frequency: FrequencyType.MONTHLY,
      approximate: false,
      nextDueDate: "2026-08-01",
      endDate: null,
      description: null,
      isTransfer: false,
      transferAccountKey: null,
      investment: null,
      splits: [principalLeg(-1100), categoryLeg(61, -500)].map((split) => ({
        kind: split.kind,
        categoryHandle: split.categoryHandle,
        transferAccountKey: split.transferAccountKey,
        amount: split.amount,
        memo: split.memo,
      })),
      tagHandles: [],
    };

    const result = mapLoans(
      input({
        transactions: transactionsFixture([splitPayment()]),
        bills: [bill],
      }),
    );

    expect(result.loans[0]).toMatchObject({
      paymentAmount: 1600,
      paymentFrequency: FrequencyType.MONTHLY,
      paymentStartDate: "2026-08-01",
    });
  });

  it("takes terms from a bill even when no payment was ever posted", () => {
    const bill: MappedBill = {
      handle: 7,
      seriesKey: 7,
      status: 0,
      name: "Mortgage payment",
      accountKey: "acct-1",
      payeeHandle: null,
      categoryHandle: null,
      amount: -1600,
      currencyCode: "USD",
      frequency: FrequencyType.MONTHLY,
      approximate: false,
      nextDueDate: "2026-08-01",
      endDate: null,
      description: null,
      isTransfer: true,
      transferAccountKey: "acct-9",
      investment: null,
      splits: [],
      tagHandles: [],
    };

    const result = mapLoans(input({ bills: [bill] }));

    expect(result.loans).toHaveLength(1);
    expect(result.loans[0]).toMatchObject({
      accountKey: "acct-9",
      sourceAccountKey: "acct-1",
      paymentAmount: 1600,
      paymentsObserved: 0,
      interestBookingMode: null,
    });
    // No payments were observed, so nothing to be unclear about.
    expect(result.warnings).toEqual([]);
  });

  it("falls back to the most common payment total when there is no bill", () => {
    const result = mapLoans(
      input({
        transactions: transactionsFixture([
          splitPayment(),
          splitPayment(),
          transaction({
            amount: -2000,
            splits: [principalLeg(-1500), categoryLeg(61, -500)],
          }),
        ]),
      }),
    );

    expect(result.loans[0].paymentAmount).toBe(1500);
  });
});
