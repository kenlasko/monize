import { EntityManager } from "typeorm";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  MappedInvestmentTransaction,
  MappedSecurity,
} from "../model/mny-import-model";
import { writeInvestments, writeSecurities } from "./write-investments";
import { currencyKindRows } from "../../../test-helpers/currency-kind-testing";

/**
 * The investment writer's contract: securities are find-or-create by symbol, a
 * cash leg is one plain transaction in the cash sleeve (never a transfer pair
 * that would give the brokerage side a balance the file never had), and the
 * share-transfer link is back-patched after every row exists because the column
 * is a self-referencing foreign key.
 */

function security(overrides: Partial<MappedSecurity> = {}): MappedSecurity {
  return {
    handle: 1,
    symbol: "VOO",
    moneySymbol: "VOO",
    name: "Vanguard S&P 500",
    currencyCode: "USD",
    skipPriceUpdates: false,
    ...overrides,
  };
}

function investment(
  overrides: Partial<MappedInvestmentTransaction> = {},
): MappedInvestmentTransaction {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    handle: 1,
    accountKey: "acct-10",
    cashAccountKey: "acct-11",
    fundingAccountKey: null,
    cashTransactionId: null,
    transactionSplitId: null,
    securityHandle: 1,
    action: InvestmentAction.BUY,
    transactionDate: "2026-01-15",
    quantity: 10,
    price: 100,
    commission: 9.99,
    accruedInterest: 0,
    totalAmount: 1009.99,
    currencyCode: "USD",
    securityCurrencyCode: "USD",
    exchangeRate: 1,
    cashAmount: -1009.99,
    status: TransactionStatus.CLEARED,
    payeeHandle: null,
    categoryHandle: null,
    description: null,
    linkedInvestmentId: null,
    tagHandles: [],
    ...overrides,
  };
}

interface Doubles {
  manager: EntityManager;
  securities: Record<string, jest.Mock>;
  investments: Record<string, jest.Mock>;
  transactions: Record<string, jest.Mock>;
  query: jest.Mock;
}

/** The statements that back-patch the transfer links. */
const linkUpdates = (query: jest.Mock) =>
  query.mock.calls.filter(([sql]) =>
    String(sql).includes("UPDATE investment_transactions"),
  );

function doubles(
  existingSecurities: { id: string; symbol: string }[] = [],
  /** Securities the user has linked to a bond program, and the series on sale. */
  bond: {
    linked: string[];
    onSale: string[];
    /** Successive answers of the ledger read (before the write, after it); the last repeats. */
    ledgers?: Array<Array<Record<string, unknown>>>;
  } = { linked: [], onSale: [] },
) {
  let ledgerReads = 0;
  const securities = {
    find: jest.fn().mockResolvedValue(existingSecurities),
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
  const investments = {
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
  const transactions = {
    insert: jest.fn().mockResolvedValue(undefined),
  } as unknown as Record<string, jest.Mock>;
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    // The `currencies` kind read (INV-CRYPTO-001) answers BTC as a coin.
    const kindRows = currencyKindRows(sql, params);
    if (kindRows) return kindRows;
    if (sql.includes("bond_auto_fetch")) {
      return [
        {
          id: "ssssssss-0000-0000-0000-000000000001",
          user_id: "user-1",
          symbol: "EDO",
          currency_code: "PLN",
          bond_program_id: "program-1",
          bond_auto_fetch: false,
        },
      ];
    }
    if (sql.includes("counterpart_account_id")) {
      const all = bond.ledgers ?? [[]];
      const rows = all[Math.min(ledgerReads, all.length - 1)];
      ledgerReads += 1;
      return rows;
    }
    if (sql.includes("s.bond_program_id AS id")) {
      // The real lookup: a security that is not linked has no program.
      return bond.linked.includes(params[0] as string)
        ? [{ id: "program-1", program_code: "EDO" }]
        : [{ id: null, program_code: null }];
    }
    if (sql.includes("saleWindow")) return bond.onSale.map((id) => ({ id }));
    return [[], 0];
  });

  const manager = {
    getRepository: jest.fn((entity: { name?: string }) => {
      if (entity?.name === "Security") return securities;
      if (entity?.name === "InvestmentTransaction") return investments;
      return transactions;
    }),
    query,
  } as unknown as EntityManager;

  return { manager, securities, investments, transactions, query } as Doubles;
}

const baseInput = {
  accountIdByKey: new Map([
    ["acct-10", "aaaaaaaa-0000-0000-0000-000000000010"],
    ["acct-11", "aaaaaaaa-0000-0000-0000-000000000011"],
  ]),
  securityIdByHandle: new Map([[1, "ssssssss-0000-0000-0000-000000000001"]]),
  categoryIdByHandle: new Map<number, string>(),
  payeeIdByHandle: new Map<number, string>(),
  payeeNameByHandle: new Map<number, string>(),
  symbolByHandle: new Map([[1, "VOO"]]),
  tagIdByHandle: new Map([[552, "tag-552"]]),
};

describe("writeSecurities", () => {
  it("refuses a security in a CRYPTO currency before inserting any (INV-CRYPTO-001)", async () => {
    const { manager, securities } = doubles();

    await expect(
      writeSecurities(manager, "user-1", [
        security({ handle: 1, symbol: "VOO" }),
        security({ handle: 2, symbol: "XBT", currencyCode: "BTC" }),
      ]),
    ).rejects.toThrow(/BTC is a cryptocurrency/);
    expect(securities.insert).not.toHaveBeenCalled();
  });

  it("creates the securities the user does not have", async () => {
    const { manager, securities } = doubles();

    const result = await writeSecurities(manager, "user-1", [
      security({ handle: 1, symbol: "VOO" }),
      security({ handle: 2, symbol: "VTI", name: "Total Market" }),
    ]);

    expect(result.created).toBe(2);
    expect(result.reused).toBe(0);
    expect(result.idByHandle.size).toBe(2);
    expect(securities.insert).toHaveBeenCalledTimes(1);
    expect(securities.insert.mock.calls[0][0]).toHaveLength(2);
  });

  it("reuses a security the user already has, matched case-insensitively", async () => {
    const { manager, securities } = doubles([
      { id: "existing", symbol: "voo" },
    ]);

    const result = await writeSecurities(manager, "user-1", [
      security({ handle: 1, symbol: "VOO" }),
    ]);

    expect(result.reused).toBe(1);
    expect(result.created).toBe(0);
    expect(result.idByHandle.get(1)).toBe("existing");
    expect(securities.insert).not.toHaveBeenCalled();
  });

  it("leaves the security type unset rather than guessing from Money's sct", async () => {
    const { manager, securities } = doubles();

    await writeSecurities(manager, "user-1", [security()]);

    expect(securities.insert.mock.calls[0][0][0]).toMatchObject({
      securityType: null,
      exchange: null,
      isActive: true,
    });
  });

  it("carries the placeholder-symbol flag through so quotes are not fetched", async () => {
    const { manager, securities } = doubles();

    await writeSecurities(manager, "user-1", [
      security({ symbol: "AGF*", skipPriceUpdates: true }),
    ]);

    expect(securities.insert.mock.calls[0][0][0].skipPriceUpdates).toBe(true);
  });

  it("does nothing, and does not query, when there are no securities", async () => {
    const { manager, securities } = doubles();

    const result = await writeSecurities(manager, "user-1", []);

    expect(result.created).toBe(0);
    expect(securities.find).not.toHaveBeenCalled();
  });
});

describe("writeInvestments", () => {
  it("writes the investment row and its cash leg, linked", async () => {
    const { manager, investments, transactions } = doubles();

    const result = await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment()],
    });

    expect(result.investmentTransactionsCreated).toBe(1);
    expect(result.cashTransactionsCreated).toBe(1);

    const cashRow = transactions.insert.mock.calls[0][0][0];
    const investmentRow = investments.insert.mock.calls[0][0][0];

    expect(cashRow).toMatchObject({
      accountId: "aaaaaaaa-0000-0000-0000-000000000011",
      amount: -1009.99,
      isTransfer: false,
      status: TransactionStatus.CLEARED,
    });
    expect(investmentRow).toMatchObject({
      id: "11111111-1111-1111-1111-111111111111",
      accountId: "aaaaaaaa-0000-0000-0000-000000000010",
      transactionId: cashRow.id,
      securityId: "ssssssss-0000-0000-0000-000000000001",
      action: InvestmentAction.BUY,
      quantity: 10,
      totalAmount: 1009.99,
      linkedTransactionId: null,
    });
  });

  it("puts the trade's Money classification on the cash leg it writes", async () => {
    const { manager, transactions } = doubles();

    const result = await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ tagHandles: [552, 999] })],
    });

    // The doubles hand every other entity the transactions repository, so the
    // link insert is the second call on it, after the cash row. The unknown
    // item writes nothing.
    const cashRow = transactions.insert.mock.calls[0][0][0];
    expect(result.tagLinksApplied).toBe(1);
    expect(transactions.insert).toHaveBeenCalledTimes(2);
    expect(transactions.insert.mock.calls[1][0]).toEqual([
      { transactionId: cashRow.id, tagId: "tag-552" },
    ]);
  });

  it("writes no tag link when the trade has no cash leg of its own", async () => {
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [
        investment({
          action: InvestmentAction.ADD_SHARES,
          cashAmount: 0,
          cashAccountKey: null,
          tagHandles: [552],
        }),
      ],
    });

    expect(transactions.insert).not.toHaveBeenCalled();
  });

  it("persists the mapped status on the investment row, not only the cash leg", async () => {
    // The writer used to carry the status onto the cash leg alone, so a
    // Money-voided trade's shares stayed counted while its cash claimed not to
    // have moved -- and rows with no cash leg dropped the status entirely.
    const { manager, investments } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ status: TransactionStatus.RECONCILED })],
    });

    expect(investments.insert.mock.calls[0][0][0].status).toBe(
      TransactionStatus.RECONCILED,
    );
  });

  it("writes a Money-voided trade as VOID on both the investment row and its cash leg", async () => {
    const { manager, investments, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ status: TransactionStatus.VOID })],
    });

    expect(investments.insert.mock.calls[0][0][0].status).toBe(
      TransactionStatus.VOID,
    );
    expect(transactions.insert.mock.calls[0][0][0].status).toBe(
      TransactionStatus.VOID,
    );
  });

  it("inserts the cash row before the investment row that references it", async () => {
    const { manager, investments, transactions } = doubles();
    const order: string[] = [];
    transactions.insert.mockImplementation(() => {
      order.push("cash");
      return Promise.resolve();
    });
    investments.insert.mockImplementation(() => {
      order.push("investment");
      return Promise.resolve();
    });

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment()],
    });

    expect(order).toEqual(["cash", "investment"]);
  });

  it("writes no cash leg for a share-only action", async () => {
    const { manager, transactions } = doubles();

    const result = await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [
        investment({
          action: InvestmentAction.ADD_SHARES,
          cashAccountKey: null,
          cashAmount: 0,
          totalAmount: 0,
        }),
      ],
    });

    expect(result.cashTransactionsCreated).toBe(0);
    expect(transactions.insert).not.toHaveBeenCalled();
  });

  it("back-patches the share-transfer link once both legs exist", async () => {
    const { manager, query } = doubles();
    const outId = "22222222-2222-2222-2222-222222222222";

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [
        investment({
          action: InvestmentAction.TRANSFER_IN,
          cashAccountKey: null,
          cashAmount: 0,
          linkedInvestmentId: outId,
        }),
        investment({
          id: outId,
          handle: 2,
          action: InvestmentAction.TRANSFER_OUT,
          cashAccountKey: null,
          cashAmount: 0,
          linkedInvestmentId: "11111111-1111-1111-1111-111111111111",
        }),
      ],
    });

    expect(linkUpdates(query)).toHaveLength(1);
    expect(linkUpdates(query)[0][1]).toHaveLength(4);
  });

  it("leaves a link alone when its partner was not inserted", async () => {
    const { manager, query } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [
        investment({
          linkedInvestmentId: "99999999-9999-9999-9999-999999999999",
        }),
      ],
    });

    expect(linkUpdates(query)).toHaveLength(0);
  });

  describe("a security linked to a bond program (INV-BOND-007)", () => {
    const linkedId = "ssssssss-0000-0000-0000-000000000001";

    it("stores the series the date puts on sale on an acquisition of a linked security", async () => {
      const { manager, investments } = doubles([], {
        linked: [linkedId],
        onSale: ["series-1"],
      });
      await writeInvestments(manager, "user-1", {
        ...baseInput,
        transactions: [investment()],
      });
      expect(investments.insert).toHaveBeenCalledWith([
        expect.objectContaining({ bondInstrumentId: "series-1" }),
      ]);
    });

    it("leaves a removal without a series, and an unlinked security's rows without one", async () => {
      const linked = doubles([], { linked: [linkedId], onSale: ["series-1"] });
      await writeInvestments(linked.manager, "user-1", {
        ...baseInput,
        transactions: [
          investment({ action: InvestmentAction.SELL, cashAmount: 1009.99 }),
        ],
      });
      expect(linked.investments.insert).toHaveBeenCalledWith([
        expect.objectContaining({ bondInstrumentId: null }),
      ]);
      const unlinked = doubles();
      await writeInvestments(unlinked.manager, "user-1", {
        ...baseInput,
        transactions: [investment()],
      });
      expect(unlinked.investments.insert).toHaveBeenCalledWith([
        expect.objectContaining({ bondInstrumentId: null }),
      ]);
    });

    it("stores NULL for an acquisition with no series on sale that day, and counts it, instead of refusing the import", async () => {
      const { manager, investments } = doubles([], {
        linked: [linkedId],
        onSale: [],
      });
      const result = await writeInvestments(manager, "user-1", {
        ...baseInput,
        transactions: [investment()],
      });
      expect(investments.insert).toHaveBeenCalledWith([
        expect.objectContaining({ bondInstrumentId: null }),
      ]);
      expect(result.bondRowsWithoutSeries).toBe(1);
      expect(result.investmentTransactionsCreated).toBe(1);
    });

    it("never infers the series of an ADD_SHARES or an unpaired TRANSFER_IN from its date: NULL, counted", async () => {
      const { manager, investments } = doubles([], {
        linked: [linkedId],
        onSale: ["series-1"],
      });
      const result = await writeInvestments(manager, "user-1", {
        ...baseInput,
        transactions: [
          investment({ action: InvestmentAction.ADD_SHARES, cashAmount: 0 }),
          investment({
            id: "22222222-2222-2222-2222-222222222222",
            handle: 2,
            action: InvestmentAction.TRANSFER_IN,
            cashAmount: 0,
            // The partner is not part of this import: an unpaired leg.
            linkedInvestmentId: "99999999-9999-9999-9999-999999999999",
          }),
        ],
      });
      expect(investments.insert).toHaveBeenCalledWith([
        expect.objectContaining({ bondInstrumentId: null }),
        expect.objectContaining({ bondInstrumentId: null }),
      ]);
      expect(result.bondRowsWithoutSeries).toBe(2);
    });

    it("leaves the two legs of a paired transfer without a series and does not count them", async () => {
      const { manager, investments } = doubles([], {
        linked: [linkedId],
        onSale: ["series-1"],
      });
      const inId = "11111111-1111-1111-1111-111111111111";
      const outId = "33333333-3333-3333-3333-333333333333";
      const result = await writeInvestments(manager, "user-1", {
        ...baseInput,
        transactions: [
          investment({
            id: inId,
            action: InvestmentAction.TRANSFER_IN,
            cashAmount: 0,
            cashAccountKey: null,
            linkedInvestmentId: outId,
          }),
          investment({
            id: outId,
            handle: 2,
            action: InvestmentAction.TRANSFER_OUT,
            cashAmount: 0,
            cashAccountKey: null,
            linkedInvestmentId: inId,
          }),
        ],
      });
      expect(investments.insert).toHaveBeenCalledWith([
        expect.objectContaining({ bondInstrumentId: null }),
        expect.objectContaining({ bondInstrumentId: null }),
      ]);
      expect(result.bondRowsWithoutSeries).toBe(0);
    });

    it("looks the security's program up once per run, not once per row", async () => {
      const { manager, query } = doubles([], {
        linked: [linkedId],
        onSale: ["series-1"],
      });
      await writeInvestments(manager, "user-1", {
        ...baseInput,
        transactions: [
          investment(),
          investment({ id: "22222222-2222-2222-2222-222222222222", handle: 2 }),
          investment({ id: "33333333-3333-3333-3333-333333333333", handle: 3 }),
        ],
      });
      const programLookups = query.mock.calls.filter(([sql]) =>
        String(sql).includes("s.bond_program_id AS id"),
      );
      expect(programLookups).toHaveLength(1);
    });

    it("infers the series on sale once per (program, date) across the whole import", async () => {
      const { manager, query } = doubles([], {
        linked: [linkedId],
        onSale: ["series-1"],
      });
      await writeInvestments(manager, "user-1", {
        ...baseInput,
        transactions: [
          investment(),
          investment({ id: "22222222-2222-2222-2222-222222222222", handle: 2 }),
          investment({ id: "33333333-3333-3333-3333-333333333333", handle: 3 }),
          investment({
            id: "44444444-4444-4444-4444-444444444444",
            handle: 4,
            transactionDate: "2026-02-02",
          }),
        ],
      });
      const inferences = query.mock.calls.filter(([sql]) =>
        String(sql).includes("ORDER BY s.series_code"),
      );
      expect(inferences).toHaveLength(2);
    });

    it("leaves an unlinked security untouched: no inference, no ledger read, no count", async () => {
      const { manager, query, investments } = doubles([], {
        linked: [],
        onSale: ["series-1"],
      });
      const result = await writeInvestments(manager, "user-1", {
        ...baseInput,
        transactions: [
          investment(),
          investment({
            id: "22222222-2222-2222-2222-222222222222",
            handle: 2,
            action: InvestmentAction.ADD_SHARES,
            cashAmount: 0,
          }),
        ],
      });
      expect(investments.insert).toHaveBeenCalledWith([
        expect.objectContaining({ bondInstrumentId: null }),
        expect.objectContaining({ bondInstrumentId: null }),
      ]);
      expect(result.bondRowsWithoutSeries).toBe(0);
      const bondReads = query.mock.calls.filter(([sql]) =>
        /ORDER BY s.series_code|counterpart_account_id/.test(String(sql)),
      );
      expect(bondReads).toHaveLength(0);
    });

    it("refuses the import as a whole when a removal is not covered by the lots after it (OVER_REMOVAL), and not one that already was", async () => {
      const sell = {
        id: "sell-1",
        action: "SELL",
        status: "CLEARED",
        tx_date: "2026-02-01",
        quantity: "9",
        account_id: "aaaaaaaa-0000-0000-0000-000000000010",
        bond_instrument_id: null,
        counterpart_account_id: null,
      };
      const first = doubles([], {
        linked: [linkedId],
        onSale: ["series-1"],
        ledgers: [[], [sell]],
      });
      await expect(
        writeInvestments(first.manager, "user-1", {
          ...baseInput,
          transactions: [investment()],
        }),
      ).rejects.toMatchObject({ response: { errorCode: "OVER_REMOVAL" } });

      const already = doubles([], {
        linked: [linkedId],
        onSale: ["series-1"],
        ledgers: [[sell], [sell]],
      });
      await expect(
        writeInvestments(already.manager, "user-1", {
          ...baseInput,
          transactions: [investment()],
        }),
      ).resolves.toBeDefined();
    });
  });

  it("skips rows whose account was not created", async () => {
    const { manager, investments } = doubles();

    const result = await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ accountKey: "acct-77" })],
    });

    expect(result.investmentTransactionsCreated).toBe(0);
    expect(investments.insert).not.toHaveBeenCalled();
  });

  it("reports both the brokerage and the cash account as affected", async () => {
    const { manager } = doubles();

    const result = await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment()],
    });

    expect([...result.affectedAccountIds].sort()).toEqual([
      "aaaaaaaa-0000-0000-0000-000000000010",
      "aaaaaaaa-0000-0000-0000-000000000011",
    ]);
    expect([...result.brokerageAccountIds]).toEqual([
      "aaaaaaaa-0000-0000-0000-000000000010",
    ]);
  });

  it("falls back to the security symbol when Money recorded no memo", async () => {
    const { manager, investments } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ description: null })],
    });

    expect(investments.insert.mock.calls[0][0][0].description).toBe("VOO");
  });

  it("labels the cash leg with the activity when Money recorded no payee", async () => {
    // Issue #1204: Money files carry no payee on a trade, so every imported
    // cash leg rendered as a bare "-" in the register -- the one column that
    // could say why the money moved. The label is the same one a natively
    // entered and a QIF-imported trade already store.
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment()],
    });

    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      payeeId: null,
      payeeName: "Buy: VOO 10 @ $100.00",
    });
  });

  it("quotes the label in the currency the price and total are in", async () => {
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment({ securityCurrencyCode: "EUR" })],
    });

    expect(transactions.insert.mock.calls[0][0][0].payeeName).toBe(
      "Buy: VOO 10 @ €100.00",
    );
  });

  it("keeps the cash row in the account currency when the trade is in another", async () => {
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [
        investment({
          currencyCode: "CAD",
          securityCurrencyCode: "USD",
          exchangeRate: 1.25,
          totalAmount: 1000,
          price: 100,
          commission: 0,
          cashAmount: -1250,
        }),
      ],
    });

    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      amount: -1250,
      currencyCode: "CAD",
      exchangeRate: 1,
      payeeName: "Buy: VOO 10 @ $100.00",
    });
  });

  it("labels an income leg with its total rather than a unit price", async () => {
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [
        investment({
          action: InvestmentAction.DIVIDEND,
          quantity: null,
          price: null,
          commission: 0,
          totalAmount: 42.5,
          cashAmount: 42.5,
        }),
      ],
    });

    expect(transactions.insert.mock.calls[0][0][0].payeeName).toBe(
      "Dividend: VOO $42.50",
    );
  });

  it("says Unknown when the security handle resolves to nothing", async () => {
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      symbolByHandle: new Map<number, string>(),
      transactions: [investment()],
    });

    expect(transactions.insert.mock.calls[0][0][0].payeeName).toBe(
      "Buy: Unknown 10 @ $100.00",
    );
  });

  it("carries Money's own payee and category onto the cash leg", async () => {
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      payeeIdByHandle: new Map([[4, "payee-4"]]),
      payeeNameByHandle: new Map([[4, "Broker"]]),
      categoryIdByHandle: new Map([[9, "category-9"]]),
      transactions: [investment({ payeeHandle: 4, categoryHandle: 9 })],
    });

    // The synthesized label is a fallback, never an override: a payee the
    // user recorded in Money is not replaced by generated text.
    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      payeeId: "payee-4",
      payeeName: "Broker",
      categoryId: "category-9",
    });
  });

  it("labels the leg rather than linking half a payee", async () => {
    // A handle that resolves to an id but no name (or the reverse) is not a
    // payee: writing one half leaves the register showing whichever survived.
    const { manager, transactions } = doubles();

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      payeeIdByHandle: new Map([[4, "payee-4"]]),
      payeeNameByHandle: new Map<number, string>(),
      transactions: [investment({ payeeHandle: 4 })],
    });

    expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
      payeeId: null,
      payeeName: "Buy: VOO 10 @ $100.00",
    });
  });

  describe("a trade whose cash a banking row already records", () => {
    // Issues #1211 and #1212. Money paired the trade with a row it wrote in a
    // real account -- the chequing account that paid, or a leg of a paycheque.
    // That row is the cash movement, so writing a sleeve row as well is the
    // duplicate the user sees in the register.
    const FUNDING_ROW = "bbbbbbbb-0000-0000-0000-000000000001";
    const SPLIT_LEG = "cccccccc-0000-0000-0000-000000000001";

    it("adopts the funding row instead of writing a cash leg", async () => {
      const { manager, transactions, investments } = doubles();

      await writeInvestments(manager, "user-1", {
        ...baseInput,
        writtenTransactionIds: new Set([FUNDING_ROW]),
        transactions: [
          investment({
            cashAccountKey: "acct-11",
            fundingAccountKey: "acct-11",
            cashTransactionId: FUNDING_ROW,
          }),
        ],
      });

      expect(transactions.insert).not.toHaveBeenCalled();
      expect(investments.insert.mock.calls[0][0][0]).toMatchObject({
        transactionId: FUNDING_ROW,
        transactionSplitId: null,
        fundingAccountId: "aaaaaaaa-0000-0000-0000-000000000011",
      });
    });

    it("embeds itself in a split leg and writes no cash row anywhere", async () => {
      const { manager, transactions, investments } = doubles();

      const result = await writeInvestments(manager, "user-1", {
        ...baseInput,
        writtenSplitIds: new Set([SPLIT_LEG]),
        transactions: [
          investment({
            cashAccountKey: "acct-11",
            transactionSplitId: SPLIT_LEG,
          }),
        ],
      });

      expect(transactions.insert).not.toHaveBeenCalled();
      expect(result.cashTransactionsCreated).toBe(0);
      expect(investments.insert.mock.calls[0][0][0]).toMatchObject({
        transactionId: null,
        transactionSplitId: SPLIT_LEG,
        fundingAccountId: null,
      });
    });

    it("drops a reference to a row that was not written", async () => {
      // Both columns are foreign keys, so a dangling id aborts the whole
      // import rather than losing one row.
      const { manager, investments } = doubles();

      await writeInvestments(manager, "user-1", {
        ...baseInput,
        writtenTransactionIds: new Set<string>(),
        writtenSplitIds: new Set<string>(),
        transactions: [
          investment({
            cashAccountKey: "acct-11",
            cashTransactionId: FUNDING_ROW,
            transactionSplitId: SPLIT_LEG,
          }),
        ],
      });

      expect(investments.insert.mock.calls[0][0][0]).toMatchObject({
        transactionId: null,
        transactionSplitId: null,
      });
    });

    it("stores the rate the settlement happened at, not 1", async () => {
      // A trade funded from an account in another currency: 1 here would post
      // the cash unconverted.
      const { manager, investments } = doubles();

      await writeInvestments(manager, "user-1", {
        ...baseInput,
        writtenTransactionIds: new Set([FUNDING_ROW]),
        transactions: [
          investment({
            cashAccountKey: "acct-11",
            fundingAccountKey: "acct-11",
            cashTransactionId: FUNDING_ROW,
            exchangeRate: 1.3652,
          }),
        ],
      });

      expect(investments.insert.mock.calls[0][0][0]).toMatchObject({
        exchangeRate: 1.3652,
      });
    });
  });

  /**
   * Money's "Redeem CD/Bond" (`act` 30) is a REDEEM, and the code map asserting
   * that is not enough on its own: what the user sees is the row this writer
   * persists. The companion carrying the accrued interest is written beside it
   * with no cash row of its own, and the pair is linked by the same back-patch
   * pass a share transfer uses.
   */
  describe("a redemption carrying accrued interest", () => {
    const REDEMPTION = "22222222-2222-2222-2222-222222222222";
    const COMPANION = "33333333-3333-3333-3333-333333333333";

    const pair = (): MappedInvestmentTransaction[] => [
      investment({
        id: REDEMPTION,
        action: InvestmentAction.REDEEM,
        quantity: 10,
        price: 1000,
        commission: 25,
        totalAmount: 9975,
        cashAmount: 10062.5,
        linkedInvestmentId: COMPANION,
      }),
      investment({
        id: COMPANION,
        handle: null,
        action: InvestmentAction.INTEREST,
        quantity: null,
        price: 87.5,
        commission: 0,
        totalAmount: 87.5,
        cashAccountKey: null,
        cashAmount: 0,
        linkedInvestmentId: REDEMPTION,
      }),
    ];

    it("persists act=30 as REDEEM, not as a sale", async () => {
      const { manager, investments } = doubles();

      await writeInvestments(manager, "user-1", {
        ...baseInput,
        transactions: pair(),
      });

      const rows = investments.insert.mock.calls[0][0];
      expect(rows[0]).toMatchObject({
        id: REDEMPTION,
        action: InvestmentAction.REDEEM,
        totalAmount: 9975,
      });
    });

    it("writes one cash row, for the proceeds plus the interest", async () => {
      const { manager, transactions, investments } = doubles();

      const result = await writeInvestments(manager, "user-1", {
        ...baseInput,
        transactions: pair(),
      });

      expect(result.cashTransactionsCreated).toBe(1);
      expect(transactions.insert.mock.calls[0][0]).toHaveLength(1);
      expect(transactions.insert.mock.calls[0][0][0]).toMatchObject({
        accountId: "aaaaaaaa-0000-0000-0000-000000000011",
        amount: 10062.5,
      });
      expect(investments.insert.mock.calls[0][0][1]).toMatchObject({
        action: InvestmentAction.INTEREST,
        totalAmount: 87.5,
        transactionId: null,
      });
    });

    it("links the pair through the back-patch pass", async () => {
      const { manager, query } = doubles();

      const result = await writeInvestments(manager, "user-1", {
        ...baseInput,
        transactions: pair(),
      });

      expect(result.linksApplied).toBe(2);
      const linkCall = query.mock.calls.find(([sql]: [string]) =>
        String(sql).includes("linked_transaction_id"),
      );
      expect(linkCall?.[1]).toEqual(
        expect.arrayContaining([REDEMPTION, COMPANION]),
      );
    });
  });

  it("reports progress after every chunk", async () => {
    const { manager } = doubles();
    const onProgress = jest.fn().mockResolvedValue(undefined);

    await writeInvestments(manager, "user-1", {
      ...baseInput,
      transactions: [investment(), investment({ id: "b", handle: 2 })],
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith(2, 2);
  });
});
