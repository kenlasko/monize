import { DataSource } from "typeorm";
import { useKmyImportHarness } from "../helpers/kmy-import-harness";
import {
  kmyAccount,
  kmyFile,
  kmySecurity,
  kmySplit,
  kmyTransaction,
  kmyTxId,
  toKmyBytes,
} from "@/import/kmy/__fixtures__/kmy-xml-builders";

/**
 * Spec 5.7.7 (M4) against PostgreSQL: a paycheque that also buys shares is
 * a split row in the chequing account with the purchase embedded in its
 * INVESTMENT leg, so the account, the categories and the holding each come
 * out as KMyMoney shows them.
 */
describe("kmy import: a transaction that fits no investment activity (integration)", () => {
  const h = useKmyImportHarness();
  let dataSource: DataSource;
  let userId: string;

  beforeAll(() => {
    ({ dataSource, userId } = h);
  });

  it("writes the paycheque's legs, the embedded purchase and the holding", async () => {
    const xml = kmyFile({
      accounts: [
        kmyAccount({ id: "A000001", name: "Checking", type: 1 }),
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
        kmyAccount({
          id: "A000004",
          name: "Salary",
          type: 12,
          parentaccount: "AStd::Income",
        }),
        kmyAccount({
          id: "A000005",
          name: "Taxes",
          type: 13,
          parentaccount: "AStd::Expense",
        }),
      ],
      securities: [kmySecurity()],
      transactions: [
        kmyTransaction(
          [
            kmySplit({
              id: "S0001",
              account: "A000004",
              value: "-5000/1",
              shares: "-5000/1",
            }),
            kmySplit({
              id: "S0002",
              account: "A000005",
              value: "1000/1",
              shares: "1000/1",
            }),
            kmySplit({
              id: "S0003",
              account: "A000001",
              value: "3500/1",
              shares: "3500/1",
            }),
            kmySplit({
              id: "S0004",
              account: "A000003",
              action: "Buy",
              value: "500/1",
              shares: "10/1",
              price: "50/1",
            }),
          ],
          { id: kmyTxId(1), postdate: "2024-01-31" },
        ),
      ],
    });

    const job = await h.runKmy(toKmyBytes(xml, "gzip"));
    expect(job.status).toBe("completed");
    const result = job.result!;
    expect(result.verification).toHaveLength(3);
    for (const line of result.verification) {
      expect([line.accountName, line.delta, line.matches]).toEqual([
        line.accountName,
        0,
        true,
      ]);
    }
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "investmentTransactionUnclassified",
    );

    expect(await h.balanceOf("Checking")).toBe(3500);
    expect(await h.balanceOf("Broker - Cash")).toBe(0);

    const legs: {
      kind: string;
      amount: string;
      category: string | null;
      id: string;
    }[] = await dataSource.query(
      `SELECT s.kind, s.amount, c.name AS category, s.id
         FROM transaction_splits s
         JOIN transactions t ON t.id = s.transaction_id
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = s.category_id
        WHERE t.user_id = $1 AND a.name = 'Checking'
        ORDER BY s.amount DESC`,
      [userId],
    );
    expect(legs.map((l) => [l.kind, Number(l.amount), l.category])).toEqual([
      ["category", 5000, "Salary"],
      ["investment", -500, null],
      ["category", -1000, "Taxes"],
    ]);

    const trades: {
      action: string;
      quantity: string;
      total_amount: string;
      commission: string;
      transaction_split_id: string | null;
      transaction_id: string | null;
    }[] = await dataSource.query(
      `SELECT action, quantity, total_amount, commission, transaction_split_id, transaction_id
         FROM investment_transactions WHERE user_id = $1`,
      [userId],
    );
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      action: "BUY",
      transaction_split_id: legs[1].id,
      transaction_id: null,
    });
    expect(Number(trades[0].quantity)).toBe(10);
    expect(Number(trades[0].total_amount)).toBe(500);
    expect(Number(trades[0].commission)).toBe(0);

    // No row in the brokerage cash account, no investment income.
    const cashRows: { n: string }[] = await dataSource.query(
      `SELECT count(*) AS n FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = $1 AND a.name = 'Broker - Cash'`,
      [userId],
    );
    expect(Number(cashRows[0].n)).toBe(0);

    const held: { quantity: string; average_cost: string }[] =
      await dataSource.query(
        `SELECT h.quantity, h.average_cost FROM holdings h
           JOIN accounts a ON a.id = h.account_id
          WHERE a.user_id = $1 AND h.quantity <> 0`,
        [userId],
      );
    expect(held.map((row) => Number(row.quantity))).toEqual([10]);
    expect(Number(held[0].quantity) * Number(held[0].average_cost)).toBe(500);
  });
});
