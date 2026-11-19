import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import {
  investmentData,
  mnyAccount,
  mnyCurrency,
  mnyDefaults,
  mnyInvestmentDetail,
  mnySecurity,
  mnyTransaction,
  referenceData,
  transactionData,
} from "../__fixtures__/mny-row-builders";
import { MappedInvestmentTransaction } from "../model/mny-import-model";
import { MNY_ACTION } from "../model/mny-actions";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "../model/mny-import-options";
import { mapInvestments } from "./map-investments";
import { mapAccounts } from "./map-reference";
import { mapSecurities } from "./map-securities";
import { moneyJournalIds, orderForReplay } from "./replay-order";

describe("orderForReplay (S1)", () => {
  const row = (id: string, transactionDate: string) =>
    ({ id, transactionDate }) as MappedInvestmentTransaction;

  it("orders by date, then by id, as INVESTMENT_REPLAY_ORDER does for rows sharing created_at", () => {
    const ordered = orderForReplay([
      row("0000000c", "2024-03-01"),
      row("0000000b", "2024-01-02"),
      row("0000000a", "2024-03-01"),
    ]);
    expect(ordered.map((r) => r.id)).toEqual([
      "0000000b",
      "0000000a",
      "0000000c",
    ]);
  });
});

describe("moneyJournalIds (S1)", () => {
  it("hands out ids in date then htrn order, whatever the physical row order", () => {
    const ids = moneyJournalIds([
      mnyTransaction({ handle: 30, security: 1, date: "2024-03-01" }),
      mnyTransaction({ handle: 20, security: 1, date: "2024-03-01" }),
      mnyTransaction({ handle: 40, security: 1, date: "2024-01-02" }),
    ]);
    const order = [...ids.entries()]
      .sort(([, a], [, b]) => (a.id < b.id ? -1 : 1))
      .map(([handle]) => handle);
    expect(order).toEqual([40, 20, 30]);
    // A companion's id sorts after its own row's and before the next row's.
    const [early, , late] = [ids.get(20)!, ids.get(40)!, ids.get(30)!];
    expect(early.id < early.companionId).toBe(true);
    expect(early.companionId < late.id).toBe(true);
  });

  it("gives no id to a row that imports no investment: no security, no date or no handle", () => {
    const ids = moneyJournalIds([
      mnyTransaction({ handle: 1 }),
      mnyTransaction({ handle: 2, security: 1, date: null }),
      mnyTransaction({ handle: null, security: 1 }),
    ]);
    expect(ids.size).toBe(0);
  });
});

describe("mapInvestments: same-day rows in Money's journal order (S1)", () => {
  it("returns a same-day sell and buy in htrn order with ids that sort the same way", () => {
    const reference = referenceData({
      currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
      defaults: mnyDefaults({ defaultCurrency: 1 }),
      accounts: [
        mnyAccount({
          handle: 5,
          type: 5,
          name: "Brokerage",
          relatedAccount: 6,
        }),
        mnyAccount({ handle: 6, type: 0, name: "Cash", relatedAccount: 5 }),
      ],
    });
    const accounts = mapAccounts(reference, DEFAULT_MNY_IMPORT_OPTIONS, "USD");
    const securities = mapSecurities({
      securities: [mnySecurity({ handle: 9, symbol: "VOO" })],
      currencyByHandle: new Map(),
      baseCurrency: "USD",
      activeHandles: new Set([9]),
    });
    const trade = (handle: number, action: number, amount: number) =>
      mnyTransaction({
        handle,
        account: 5,
        security: 9,
        date: "2024-03-01",
        action,
        amount,
      });

    const result = mapInvestments({
      // Physical order: the buy first, though Money entered the sell first.
      transactions: transactionData({
        transactions: [
          trade(31, MNY_ACTION.BUY, 2000),
          trade(22, MNY_ACTION.SELL, 2500),
        ],
      }),
      investments: investmentData({
        investmentDetails: [
          mnyInvestmentDetail({ transaction: 31, price: 20, quantity: 100 }),
          mnyInvestmentDetail({ transaction: 22, price: 25, quantity: 100 }),
        ],
      }),
      accounts,
      securities,
      bills: [],
      exchangeRates: [],
    });

    expect(result.transactions.map((r) => [r.handle, r.action])).toEqual([
      [22, InvestmentAction.SELL],
      [31, InvestmentAction.BUY],
    ]);
    const [first, second] = result.transactions;
    expect(first.id < second.id).toBe(true);
  });
});
