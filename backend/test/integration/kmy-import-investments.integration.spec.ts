import { DataSource } from "typeorm";
import { useKmyImportHarness } from "../helpers/kmy-import-harness";
import {
  kmyAccount,
  kmyCurrency,
  kmyFile,
  kmyPrice,
  kmyPricePair,
  kmySecurity,
  kmySplit,
  kmyTransaction,
  kmyTxId,
  toKmyBytes,
} from "@/import/kmy/__fixtures__/kmy-xml-builders";

describe("kmy import: investment builder files (integration)", () => {
  const h = useKmyImportHarness();
  let dataSource: DataSource;
  let userId: string;
  const { runKmy, balanceOf } = h;

  beforeAll(() => {
    ({ dataSource, userId } = h);
  });

  const equity = kmyAccount(
    {
      id: "A000099",
      name: "Opening Balances",
      type: 16,
      parentaccount: "AStd::Equity",
    },
    { kvp: { OpeningBalanceAccount: "Yes" } },
  );
  const fee = kmyAccount({
    id: "A000098",
    name: "Bank Fees",
    type: 13,
    parentaccount: "AStd::Expense",
  });

  /** Opening balance: `value` into `account`, out of the equity account. */
  const opening = (n: number, account: string, value: string) =>
    kmyTransaction(
      [
        kmySplit({
          id: "S0001",
          account,
          value: `${value}/1`,
          shares: `${value}/1`,
        }),
        kmySplit({
          id: "S0002",
          account: "A000099",
          value: `-${value}/1`,
          shares: `-${value}/1`,
        }),
      ],
      { id: kmyTxId(n), postdate: "2024-01-01" },
    );

  const holdingsOf = async (
    accountName: string,
  ): Promise<{ quantity: number; cost: number }[]> => {
    const rows: { quantity: string; average_cost: string }[] =
      await dataSource.query(
        `SELECT h.quantity, h.average_cost
             FROM holdings h JOIN accounts a ON a.id = h.account_id
            WHERE a.user_id = $1 AND a.name = $2 AND h.quantity <> 0`,
        [userId, accountName],
      );
    return rows.map((row) => ({
      quantity: Number(row.quantity),
      cost: Number(row.quantity) * Number(row.average_cost),
    }));
  };

  it("imports a cross-currency trade: the cash leaves the EUR account at the file's amount and the row carries the implied rate", async () => {
    // Spec 5.7.3: EXC trades in USD, the cash account is EUR. Buy 10 at 50
    // USD with a 5 USD fee, paid with 459.09 EUR.
    const xml = kmyFile({
      accounts: [
        kmyAccount({
          id: "A000001",
          name: "EUR Cash",
          type: 1,
          currency: "EUR",
        }),
        kmyAccount(
          { id: "A000002", name: "Broker", type: 7 },
          { subaccounts: ["A000003"] },
        ),
        kmyAccount({
          id: "A000003",
          name: "Example Corp",
          type: 15,
          parentaccount: "A000002",
          currency: "E000001",
        }),
        fee,
        equity,
      ],
      securities: [kmySecurity()],
      currencies: [
        kmyCurrency({ id: "EUR", name: "Euro" }),
        kmyCurrency({ id: "USD", name: "US Dollar" }),
      ],
      prices: [
        kmyPricePair("E000001", "USD", [
          kmyPrice({ date: "2024-02-10", price: "50/1" }),
        ]),
      ],
      transactions: [
        opening(1, "A000001", "1000"),
        kmyTransaction(
          [
            kmySplit({
              id: "S0001",
              account: "A000001",
              value: "-505/1",
              shares: "-45909/100",
            }),
            kmySplit({
              id: "S0002",
              account: "A000003",
              action: "Buy",
              value: "500/1",
              shares: "10/1",
              price: "50/1",
            }),
            kmySplit({
              id: "S0003",
              account: "A000098",
              value: "5/1",
              shares: "5/1",
            }),
          ],
          { id: kmyTxId(2), postdate: "2024-02-10" },
        ),
      ],
    });

    const job = await runKmy(toKmyBytes(xml, "gzip"));

    expect(job.status).toBe("completed");
    const result = job.result!;
    expect(result.investmentTransactionsCreated).toBe(1);
    expect(result.verification.map((line) => line.accountName).sort()).toEqual([
      "Broker - Brokerage",
      "Broker - Cash",
      "EUR Cash",
    ]);
    for (const line of result.verification) {
      expect(line.delta).toBe(0);
    }
    expect(result.holdings).toHaveLength(1);
    expect(result.holdings.every((h) => h.matches && h.delta === 0)).toBe(true);
    expect(
      result.holdings.map((h) => [h.accountName, h.symbol, h.importedQuantity]),
    ).toEqual([["Broker - Brokerage", "EXC", 10]]);
    expect(await balanceOf("EUR Cash")).toBe(540.91);

    const trade: {
      action: string;
      quantity: string;
      total_amount: string;
      commission: string;
      price: string;
      exchange_rate: string;
    }[] = await dataSource.query(
      `SELECT action, quantity, total_amount, commission, price, exchange_rate
           FROM investment_transactions WHERE user_id = $1`,
      [userId],
    );
    expect(trade).toHaveLength(1);
    expect(trade[0].action).toBe("BUY");
    expect(Number(trade[0].quantity)).toBe(10);
    expect(Number(trade[0].total_amount)).toBe(505);
    expect(Number(trade[0].commission)).toBe(5);
    expect(Number(trade[0].price)).toBe(50);
    // roundFxRate(459.09 / 505), never 1.
    expect(Number(trade[0].exchange_rate)).toBeCloseTo(0.9090891089, 10);

    const cashRows: { amount: string; currency_code: string }[] =
      await dataSource.query(
        `SELECT t.amount, t.currency_code FROM transactions t
             JOIN accounts a ON a.id = t.account_id
            WHERE t.user_id = $1 AND a.name = 'EUR Cash' AND t.amount < 0`,
        [userId],
      );
    expect(cashRows).toHaveLength(1);
    expect(Number(cashRows[0].amount)).toBe(-459.09);
    expect(cashRows[0].currency_code).toBe("EUR");

    const held: { quantity: string }[] = await dataSource.query(
      `SELECT h.quantity FROM holdings h JOIN accounts a ON a.id = h.account_id
          WHERE a.user_id = $1 AND h.quantity <> 0`,
      [userId],
    );
    expect(held.map((h) => Number(h.quantity))).toEqual([10]);
  });

  it("carries a security transfer between two brokerage accounts with its original cost", async () => {
    // Spec 5.7.4: Broker A bought 10 EXC for 505 (commission included); on
    // 2024-06-01 KMyMoney records Remove 10 from A and Add 10 to B.
    const xml = kmyFile({
      accounts: [
        kmyAccount({ id: "A000001", name: "Cash A", type: 1 }),
        kmyAccount(
          { id: "A000002", name: "Broker A", type: 7 },
          { subaccounts: ["A000003"] },
        ),
        kmyAccount({
          id: "A000003",
          name: "Example Corp",
          type: 15,
          parentaccount: "A000002",
          currency: "E000001",
        }),
        kmyAccount(
          { id: "A000004", name: "Broker B", type: 7 },
          { subaccounts: ["A000005"] },
        ),
        kmyAccount({
          id: "A000005",
          name: "Example Corp",
          type: 15,
          parentaccount: "A000004",
          currency: "E000001",
        }),
        fee,
        equity,
      ],
      securities: [kmySecurity()],
      prices: [
        kmyPricePair("E000001", "USD", [
          kmyPrice({ date: "2024-02-10", price: "50/1" }),
        ]),
      ],
      transactions: [
        opening(1, "A000001", "1000"),
        kmyTransaction(
          [
            kmySplit({
              id: "S0001",
              account: "A000001",
              value: "-505/1",
              shares: "-505/1",
            }),
            kmySplit({
              id: "S0002",
              account: "A000003",
              action: "Buy",
              value: "500/1",
              shares: "10/1",
              price: "50/1",
            }),
            kmySplit({
              id: "S0003",
              account: "A000098",
              value: "5/1",
              shares: "5/1",
            }),
          ],
          { id: kmyTxId(2), postdate: "2024-02-10" },
        ),
        kmyTransaction(
          [
            kmySplit({
              id: "S0001",
              account: "A000003",
              action: "Add",
              value: "0/1",
              shares: "-10/1",
            }),
          ],
          { id: kmyTxId(3), postdate: "2024-06-01" },
        ),
        kmyTransaction(
          [
            kmySplit({
              id: "S0001",
              account: "A000005",
              action: "Add",
              value: "0/1",
              shares: "10/1",
            }),
          ],
          { id: kmyTxId(4), postdate: "2024-06-01" },
        ),
      ],
    });

    const job = await runKmy(toKmyBytes(xml, "gzip"));

    expect(job.status).toBe("completed");
    const result = job.result!;
    expect(result.verification.map((line) => line.accountName).sort()).toEqual([
      "Broker A - Brokerage",
      "Broker A - Cash",
      "Broker B - Brokerage",
      "Broker B - Cash",
      "Cash A",
    ]);
    for (const line of result.verification) {
      expect(line.delta).toBe(0);
    }
    expect(result.holdings).toHaveLength(2);
    expect(result.holdings.every((h) => h.matches && h.delta === 0)).toBe(true);
    expect(
      result.holdings.map((h) => [h.accountName, h.symbol, h.importedQuantity]),
    ).toEqual([
      ["Broker A - Brokerage", "EXC", 0],
      ["Broker B - Brokerage", "EXC", 10],
    ]);

    const rows: {
      action: string;
      account: string;
      quantity: string;
      linked: string | null;
      id: string;
    }[] = await dataSource.query(
      `SELECT i.id, i.action, a.name AS account, i.quantity,
                i.linked_transaction_id AS linked
           FROM investment_transactions i JOIN accounts a ON a.id = i.account_id
          WHERE i.user_id = $1
          ORDER BY i.transaction_date, i.created_at`,
      [userId],
    );
    const out = rows.find((r) => r.action === "TRANSFER_OUT");
    const into = rows.find((r) => r.action === "TRANSFER_IN");
    expect(out?.account).toBe("Broker A - Brokerage");
    expect(into?.account).toBe("Broker B - Brokerage");
    expect(Number(out?.quantity)).toBe(10);
    expect(Number(into?.quantity)).toBe(10);
    expect(out?.linked).toBe(into?.id);
    expect(into?.linked).toBe(out?.id);
    expect(rows.some((r) => r.action === "ADD_SHARES")).toBe(false);
    expect(rows.some((r) => r.action === "REMOVE_SHARES")).toBe(false);

    // The destination holds the shares at the source's cost basis (505), and
    // the source holds none.
    expect(await holdingsOf("Broker A - Brokerage")).toEqual([]);
    const received = await holdingsOf("Broker B - Brokerage");
    expect(received).toHaveLength(1);
    expect(received[0].quantity).toBe(10);
    expect(received[0].cost).toBeCloseTo(505, 4);
  });
});
