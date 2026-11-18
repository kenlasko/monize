import { EntityManager } from "typeorm";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { ScheduledTransaction } from "../../../scheduled-transactions/entities/scheduled-transaction.entity";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { MappedBill } from "../model/mny-import-model";
import { WriteBillsInput, writeBills } from "./write-bills";

/**
 * The two rules that make this writer different from "insert what the mapper
 * produced": an unchecked bill is *absent* rather than inactive, and everything
 * lands with `auto_post = false`. Both are direct answers to PR #192 issue 2.
 */

function repoDouble(existing: unknown[] = []) {
  return {
    find: jest.fn().mockResolvedValue(existing),
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
}

/** One double per entity, so scheduled transactions and splits stay apart. */
function managerFor(
  scheduled: Record<string, jest.Mock>,
  splits: Record<string, jest.Mock>,
): EntityManager {
  return {
    getRepository: jest.fn((entity: unknown) =>
      entity === ScheduledTransaction ? scheduled : splits,
    ),
  } as unknown as EntityManager;
}

function bill(overrides: Partial<MappedBill> = {}): MappedBill {
  return {
    handle: 7,
    seriesKey: 7,
    status: 0,
    name: "Hydro One",
    accountKey: "acct-1",
    payeeHandle: 42,
    categoryHandle: 60,
    amount: -95.5,
    currencyCode: "CAD",
    frequency: FrequencyType.MONTHLY,
    approximate: false,
    nextDueDate: "2026-08-02",
    endDate: null,
    description: null,
    isTransfer: false,
    transferAccountKey: null,
    investment: null,
    splits: [],
    tagHandles: [],
    ...overrides,
  };
}

function input(overrides: Partial<WriteBillsInput> = {}): WriteBillsInput {
  return {
    bills: [bill()],
    accountIdByKey: new Map([
      ["acct-1", "account-1"],
      ["acct-9", "account-9"],
      ["acct-10", "account-10"],
      ["acct-11", "account-11"],
    ]),
    payeeIdByHandle: new Map([[42, "payee-42"]]),
    payeeNameByHandle: new Map([[42, "Hydro One"]]),
    tagIdByHandle: new Map([[552, "tag-552"]]),
    categoryIdByHandle: new Map([
      [60, "category-60"],
      [61, "category-61"],
    ]),
    securityIdByHandle: new Map([[1, "security-1"]]),
    linkedKeyByKey: new Map([
      ["acct-10", "acct-11"],
      ["acct-11", "acct-10"],
    ]),
    ...overrides,
  };
}

describe("writeBills", () => {
  it("stores the template's resolved tags on the schedule, dropping unknown items", async () => {
    const scheduled = repoDouble();

    await writeBills(
      managerFor(scheduled, repoDouble()),
      "user-1",
      input({ bills: [bill({ tagHandles: [552, 999] })] }),
    );

    expect(scheduled.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tagIds: ["tag-552"] }),
    );
  });

  it("stores the custom recurrence a source supplies, and null otherwise", async () => {
    const scheduled = repoDouble();
    const rule = { unit: "MONTH" as const, interval: 2 };

    await writeBills(
      managerFor(scheduled, repoDouble()),
      "user-1",
      input({
        bills: [
          bill({ customRecurrence: rule }),
          bill({ handle: 8, seriesKey: 8, name: "Other" }),
        ],
      }),
    );

    expect(scheduled.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Hydro One", customRecurrence: rule }),
    );
    expect(scheduled.insert).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Other", customRecurrence: null }),
    );
  });

  it("creates an active, non-auto-posting schedule from a plain bill", async () => {
    const scheduled = repoDouble();
    const splits = repoDouble();

    const written = await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input(),
    );

    expect(written).toEqual({ created: 1, reused: 0 });
    expect(scheduled.insert).toHaveBeenCalledTimes(1);
    expect(scheduled.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        accountId: "account-1",
        name: "Hydro One",
        payeeId: "payee-42",
        payeeName: "Hydro One",
        categoryId: "category-60",
        amount: -95.5,
        currencyCode: "CAD",
        frequency: FrequencyType.MONTHLY,
        nextDueDate: "2026-08-02",
        startDate: "2026-08-02",
        isActive: true,
        autoPost: false,
        isSplit: false,
        isTransfer: false,
        isInvestment: false,
      }),
    );
    expect(splits.insert).not.toHaveBeenCalled();
  });

  it("writes nothing for a bill the wizard left unticked", async () => {
    // The selection happens upstream: an unchecked bill never reaches the
    // writer, so it is absent from the database rather than inactive.
    const scheduled = repoDouble();
    const splits = repoDouble();

    const written = await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input({ bills: [] }),
    );

    expect(written).toEqual({ created: 0, reused: 0 });
    expect(scheduled.insert).not.toHaveBeenCalled();
  });

  it("writes split legs, keeping a transfer leg a transfer", async () => {
    const scheduled = repoDouble();
    const splits = repoDouble();

    await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input({
        bills: [
          bill({
            categoryHandle: null,
            amount: -1000,
            splits: [
              {
                kind: SplitKind.TRANSFER,
                categoryHandle: null,
                transferAccountKey: "acct-9",
                amount: -700,
                memo: null,
              },
              {
                kind: SplitKind.CATEGORY,
                categoryHandle: 61,
                transferAccountKey: null,
                amount: -300,
                memo: "interest",
              },
            ],
          }),
        ],
      }),
    );

    expect(scheduled.insert).toHaveBeenCalledWith(
      expect.objectContaining({ isSplit: true, categoryId: null }),
    );
    expect(splits.insert).toHaveBeenCalledTimes(2);
    expect(splits.insert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        kind: SplitKind.TRANSFER,
        transferAccountId: "account-9",
        amount: -700,
      }),
    );
    expect(splits.insert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        kind: SplitKind.CATEGORY,
        categoryId: "category-61",
        amount: -300,
        memo: "interest",
      }),
    );
  });

  it("falls back to a category leg when a transfer leg's account did not import", async () => {
    const scheduled = repoDouble();
    const splits = repoDouble();

    await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input({
        bills: [
          bill({
            splits: [
              {
                kind: SplitKind.TRANSFER,
                categoryHandle: null,
                transferAccountKey: "acct-missing",
                amount: -700,
                memo: null,
              },
            ],
          }),
        ],
      }),
    );

    expect(splits.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: SplitKind.CATEGORY,
        transferAccountId: null,
      }),
    );
  });

  it("wires an investment bill to its security and the pair's cash sleeve", async () => {
    const scheduled = repoDouble();
    const splits = repoDouble();

    await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input({
        bills: [
          bill({
            accountKey: "acct-10",
            categoryHandle: null,
            amount: -400,
            investment: {
              action: InvestmentAction.BUY,
              securityHandle: 1,
              quantity: 2,
              price: 200,
              commission: 4.99,
            },
          }),
        ],
      }),
    );

    expect(scheduled.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-10",
        isInvestment: true,
        investmentAction: InvestmentAction.BUY,
        investmentSecurityId: "security-1",
        investmentFundingAccountId: "account-11",
        investmentQuantity: 2,
        investmentPrice: 200,
        investmentCommission: 4.99,
        investmentTotalAmount: 400,
      }),
    );
  });

  it("does not persist a funding account on a non-BUY/SELL investment bill (issue #1154)", async () => {
    // A DIVIDEND settles against the brokerage's linked cash account, not a
    // funding account, so even though the account pair has a linked cash sleeve
    // the imported row must not carry one -- the same stale-column invariant the
    // scheduled-transaction service enforces on write.
    const scheduled = repoDouble();
    const splits = repoDouble();

    await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input({
        bills: [
          bill({
            accountKey: "acct-10",
            categoryHandle: null,
            amount: 75,
            investment: {
              action: InvestmentAction.DIVIDEND,
              securityHandle: 1,
              quantity: null,
              price: null,
              commission: 0,
            },
          }),
        ],
      }),
    );

    expect(scheduled.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        isInvestment: true,
        investmentAction: InvestmentAction.DIVIDEND,
        investmentSecurityId: "security-1",
        investmentFundingAccountId: null,
      }),
    );
  });

  it("still creates a bill whose payee, category or transfer account did not import", async () => {
    // A reference that did not survive the import must not take the bill down
    // with it: the schedule is still worth having with a blank field.
    const scheduled = repoDouble();
    const splits = repoDouble();

    await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input({
        bills: [
          bill({
            payeeHandle: 99,
            categoryHandle: 99,
            isTransfer: true,
            transferAccountKey: "acct-missing",
          }),
        ],
      }),
    );

    expect(scheduled.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        payeeId: null,
        payeeName: null,
        categoryId: null,
        transferAccountId: null,
        isTransfer: true,
      }),
    );
  });

  it("creates a bill with no payee at all", async () => {
    const scheduled = repoDouble();
    const splits = repoDouble();

    await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input({ bills: [bill({ payeeHandle: null })] }),
    );

    expect(scheduled.insert).toHaveBeenCalledWith(
      expect.objectContaining({ payeeId: null, payeeName: null }),
    );
  });

  it("writes an investment bill whose account has no cash sleeve", async () => {
    // A brokerage account with no linked cash side has nothing to fund from.
    const scheduled = repoDouble();
    const splits = repoDouble();

    await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input({
        bills: [
          bill({
            accountKey: "acct-1",
            investment: {
              action: InvestmentAction.BUY,
              securityHandle: 99,
              quantity: null,
              price: null,
              commission: 0,
            },
          }),
        ],
      }),
    );

    expect(scheduled.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        isInvestment: true,
        investmentSecurityId: null,
        investmentFundingAccountId: null,
        investmentQuantity: null,
        investmentPrice: null,
      }),
    );
  });

  it("skips a bill whose account did not import", async () => {
    const scheduled = repoDouble();
    const splits = repoDouble();

    const written = await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input({ bills: [bill({ accountKey: "acct-missing" })] }),
    );

    expect(written).toEqual({ created: 0, reused: 0 });
    expect(scheduled.insert).not.toHaveBeenCalled();
  });

  it("reuses an identical existing schedule rather than duplicating it", async () => {
    const scheduled = repoDouble([
      {
        id: "existing",
        accountId: "account-1",
        name: "Hydro One",
        amount: "-95.5000",
        frequency: FrequencyType.MONTHLY,
      },
    ]);
    const splits = repoDouble();

    const written = await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input(),
    );

    expect(written).toEqual({ created: 0, reused: 1 });
    expect(scheduled.insert).not.toHaveBeenCalled();
  });

  it("does not create the same bill twice within one import", async () => {
    const scheduled = repoDouble();
    const splits = repoDouble();

    const written = await writeBills(
      managerFor(scheduled, splits),
      "user-1",
      input({ bills: [bill(), bill({ handle: 8, seriesKey: 8 })] }),
    );

    expect(written).toEqual({ created: 1, reused: 1 });
  });
});
