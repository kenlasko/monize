import { DataSource } from "typeorm";
import { useKmyImportHarness } from "../helpers/kmy-import-harness";
import {
  kmyAccount,
  kmyCurrency,
  kmyFile,
  kmySplit,
  kmyTransaction,
  kmyTxId,
  toKmyBytes,
} from "@/import/kmy/__fixtures__/kmy-xml-builders";

describe("kmy import: banking builder files (integration)", () => {
  const h = useKmyImportHarness();
  let dataSource: DataSource;
  let userId: string;
  const { runKmy, balanceOf } = h;

  beforeAll(() => {
    ({ dataSource, userId } = h);
  });

  /** Checking, a three-level category tree and a 100 loan payment (90 + 10). */
  const loanFile = () =>
    kmyFile({
      accounts: [
        kmyAccount({ id: "A000001", name: "Checking", type: 1 }),
        kmyAccount({
          id: "A000002",
          name: "Car Loan",
          type: 5,
          parentaccount: "AStd::Liability",
        }),
        kmyAccount({
          id: "A000003",
          name: "Home",
          type: 13,
          parentaccount: "AStd::Expense",
        }),
        kmyAccount({
          id: "A000004",
          name: "Utilities",
          type: 13,
          parentaccount: "A000003",
        }),
        kmyAccount({
          id: "A000005",
          name: "Water",
          type: 13,
          parentaccount: "A000004",
        }),
        kmyAccount({
          id: "A000006",
          name: "Loan Interest",
          type: 13,
          parentaccount: "AStd::Expense",
        }),
        kmyAccount(
          {
            id: "A000007",
            name: "Opening Balances",
            type: 16,
            parentaccount: "AStd::Equity",
          },
          { kvp: { OpeningBalanceAccount: "Yes" } },
        ),
      ],
      transactions: [
        kmyTransaction(
          [
            kmySplit({
              id: "S0001",
              account: "A000001",
              value: "1000/1",
              shares: "1000/1",
            }),
            kmySplit({
              id: "S0002",
              account: "A000007",
              value: "-1000/1",
              shares: "-1000/1",
            }),
          ],
          { id: kmyTxId(1), postdate: "2024-01-01" },
        ),
        kmyTransaction(
          [
            kmySplit({
              id: "S0001",
              account: "A000001",
              value: "-40/1",
              shares: "-40/1",
            }),
            kmySplit({
              id: "S0002",
              account: "A000005",
              value: "40/1",
              shares: "40/1",
            }),
          ],
          { id: kmyTxId(2), postdate: "2024-01-10" },
        ),
        // Loan payment: 100 from Checking = 90 principal + 10 interest.
        kmyTransaction(
          [
            kmySplit({
              id: "S0001",
              account: "A000001",
              value: "-100/1",
              shares: "-100/1",
            }),
            kmySplit({
              id: "S0002",
              account: "A000002",
              value: "90/1",
              shares: "90/1",
            }),
            kmySplit({
              id: "S0003",
              account: "A000006",
              value: "10/1",
              shares: "10/1",
            }),
          ],
          { id: kmyTxId(3), postdate: "2024-02-10" },
        ),
      ],
    });

  it("imports a three-level category tree and a loan payment with matching counts", async () => {
    const xml = loanFile();

    const job = await runKmy(toKmyBytes(xml, "gzip"));
    expect(job.status).toBe("completed");
    const result = job.result!;
    expect(result.categoriesCreated).toBe(4);
    expect(result.transactionsCreated).toBe(3);
    expect(result.verification.map((line) => line.accountName).sort()).toEqual([
      "Car Loan",
      "Checking",
    ]);
    for (const line of result.verification) {
      expect(line.delta).toBe(0);
    }
    expect(await balanceOf("Checking")).toBe(860);

    const tree: { name: string; parent: string | null }[] =
      await dataSource.query(
        `SELECT c.name, p.name AS parent FROM categories c
             LEFT JOIN categories p ON p.id = c.parent_id
            WHERE c.user_id = $1`,
        [userId],
      );
    const byName = new Map(tree.map((c) => [c.name, c.parent]));
    expect(byName.get("Water")).toBe("Utilities");
    expect(byName.get("Utilities")).toBe("Home");
    expect(byName.get("Home")).toBeNull();
  });

  it("writes a loan payment's transfer leg and interest leg, and the loan's counterpart row", async () => {
    expect((await runKmy(toKmyBytes(loanFile(), "gzip"))).status).toBe(
      "completed",
    );

    const rows: {
      id: string;
      account: string;
      amount: string;
      is_split: boolean;
      is_transfer: boolean;
      linked: string | null;
    }[] = await dataSource.query(
      `SELECT t.id, a.name AS account, t.amount, t.is_split, t.is_transfer,
              t.linked_transaction_id AS linked
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = $1 AND t.transaction_date = '2024-02-10'`,
      [userId],
    );
    expect(rows.map((r) => [r.account, Number(r.amount)]).sort()).toEqual([
      ["Car Loan", 90],
      ["Checking", -100],
    ]);
    const parent = rows.find((r) => r.account === "Checking")!;
    const counterpart = rows.find((r) => r.account === "Car Loan")!;
    expect(parent.is_split).toBe(true);
    // 5.6.3: the counterpart is a transfer row pointing at the parent.
    expect(counterpart.is_transfer).toBe(true);
    expect(counterpart.linked).toBe(parent.id);

    const splits: {
      kind: string;
      category: string | null;
      transfer_account: string | null;
      linked: string | null;
      amount: string;
    }[] = await dataSource.query(
      `SELECT s.kind, c.name AS category, ta.name AS transfer_account,
              s.linked_transaction_id AS linked, s.amount
         FROM transaction_splits s
         LEFT JOIN categories c ON c.id = s.category_id
         LEFT JOIN accounts ta ON ta.id = s.transfer_account_id
        WHERE s.transaction_id = $1 ORDER BY s.amount`,
      [parent.id],
    );
    expect(
      splits.map((s) => [
        s.kind,
        s.category,
        s.transfer_account,
        Number(s.amount),
      ]),
    ).toEqual([
      ["transfer", null, "Car Loan", -90],
      ["category", "Loan Interest", null, -10],
    ]);
    expect(splits[0].linked).toBe(counterpart.id);
    expect(splits.reduce((sum, s) => sum + Number(s.amount), 0)).toBe(
      Number(parent.amount),
    );
  });

  it("links transfers in both directions with opposite amounts (A to B and B to A)", async () => {
    const leg = (id: string, account: string, value: string) =>
      kmySplit({ id, account, value: `${value}/1`, shares: `${value}/1` });
    const xml = kmyFile({
      accounts: [
        kmyAccount({ id: "A000001", name: "Checking", type: 1 }),
        kmyAccount({ id: "A000002", name: "Savings", type: 2 }),
        kmyAccount(
          {
            id: "A000003",
            name: "Opening Balances",
            type: 16,
            parentaccount: "AStd::Equity",
          },
          { kvp: { OpeningBalanceAccount: "Yes" } },
        ),
      ],
      transactions: [
        kmyTransaction(
          [leg("S0001", "A000001", "1000"), leg("S0002", "A000003", "-1000")],
          { id: kmyTxId(1), postdate: "2024-01-01" },
        ),
        kmyTransaction(
          [leg("S0001", "A000002", "1000"), leg("S0002", "A000003", "-1000")],
          { id: kmyTxId(2), postdate: "2024-01-01" },
        ),
        // A to B: Checking pays 200 into Savings.
        kmyTransaction(
          [leg("S0001", "A000001", "-200"), leg("S0002", "A000002", "200")],
          { id: kmyTxId(3), postdate: "2024-02-01" },
        ),
        // B to A: Savings pays 50 back into Checking.
        kmyTransaction(
          [leg("S0001", "A000002", "-50"), leg("S0002", "A000001", "50")],
          { id: kmyTxId(4), postdate: "2024-03-01" },
        ),
      ],
    });

    const job = await runKmy(toKmyBytes(xml, "gzip"));
    expect(job.status).toBe("completed");
    expect(job.result!.transfersLinked).toBe(2);

    const rows: {
      id: string;
      account: string;
      date: string;
      amount: string;
      is_transfer: boolean;
      linked: string | null;
    }[] = await dataSource.query(
      `SELECT t.id, a.name AS account, TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS date,
              t.amount, t.is_transfer, t.linked_transaction_id AS linked
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = $1 ORDER BY t.transaction_date, t.amount`,
      [userId],
    );
    expect(rows.map((r) => [r.date, r.account, Number(r.amount)])).toEqual([
      ["2024-02-01", "Checking", -200],
      ["2024-02-01", "Savings", 200],
      ["2024-03-01", "Savings", -50],
      ["2024-03-01", "Checking", 50],
    ]);
    for (const [from, to] of [
      [rows[0], rows[1]],
      [rows[2], rows[3]],
    ]) {
      expect(from.is_transfer).toBe(true);
      expect(to.is_transfer).toBe(true);
      expect(from.linked).toBe(to.id);
      expect(to.linked).toBe(from.id);
      expect(Number(from.amount)).toBe(-Number(to.amount));
    }
    // 1000 - 200 + 50 and 1000 + 200 - 50.
    expect(await balanceOf("Checking")).toBe(850);
    expect(await balanceOf("Savings")).toBe(1150);
  });

  it("writes a split row's foreign transfer leg in the shape Monize's own split writes, both directions (spec 5.6.4.1)", async () => {
    // Commodity EUR. 2024-02-01: EUR Savings receives 100 = 33 USD from
    // Checking (worth 30 EUR) + 70 Salary. 2024-03-01: EUR Savings pays 100 =
    // 33 USD into Checking (30 EUR) + 70 Groceries.
    const split = (
      id: string,
      account: string,
      value: string,
      shares = value,
    ) => kmySplit({ id, account, value: `${value}/1`, shares: `${shares}/1` });
    const xml = kmyFile({
      accounts: [
        kmyAccount({ id: "A000001", name: "Checking", type: 1 }),
        kmyAccount({
          id: "A000002",
          name: "EUR Savings",
          type: 2,
          currency: "EUR",
        }),
        kmyAccount({
          id: "A000003",
          name: "Salary",
          type: 12,
          parentaccount: "AStd::Income",
          currency: "EUR",
        }),
        kmyAccount({
          id: "A000004",
          name: "Groceries",
          type: 13,
          parentaccount: "AStd::Expense",
          currency: "EUR",
        }),
      ],
      currencies: [
        kmyCurrency({ id: "EUR", name: "Euro" }),
        kmyCurrency({ id: "USD", name: "US Dollar" }),
      ],
      transactions: [
        kmyTransaction(
          [
            split("S0001", "A000002", "100"),
            split("S0002", "A000001", "-30", "-33"),
            split("S0003", "A000003", "-70"),
          ],
          { id: kmyTxId(1), postdate: "2024-02-01", commodity: "EUR" },
        ),
        kmyTransaction(
          [
            split("S0001", "A000002", "-100"),
            split("S0002", "A000001", "30", "33"),
            split("S0003", "A000004", "70"),
          ],
          { id: kmyTxId(2), postdate: "2024-03-01", commodity: "EUR" },
        ),
      ],
    });

    const job = await runKmy(toKmyBytes(xml, "gzip"));
    expect(job.status).toBe("completed");
    expect(job.result!.warnings.map((w) => w.code)).not.toContain(
      "crossCurrencyTransferRateMissing",
    );
    for (const line of job.result!.verification) {
      expect(line.delta).toBe(0);
    }

    const rows: {
      id: string;
      account: string;
      date: string;
      amount: string;
      currency: string;
      rate: string | null;
      is_split: boolean;
      is_transfer: boolean;
      linked: string | null;
    }[] = await dataSource.query(
      `SELECT t.id, a.name AS account, TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS date,
              t.amount, t.currency_code AS currency, t.exchange_rate AS rate,
              t.is_split, t.is_transfer, t.linked_transaction_id AS linked
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = $1 ORDER BY t.transaction_date, t.amount`,
      [userId],
    );
    expect(
      rows.map((r) => [
        r.date,
        r.account,
        Number(r.amount),
        r.currency,
        Number(r.rate),
        r.is_split,
        r.is_transfer,
      ]),
    ).toEqual([
      // The parent keeps 1 (an amount in its own currency); the counterpart
      // carries USD per EUR whichever way the money moves.
      ["2024-02-01", "Checking", -33, "USD", 1.1, false, true],
      ["2024-02-01", "EUR Savings", 100, "EUR", 1, true, false],
      ["2024-03-01", "EUR Savings", -100, "EUR", 1, true, false],
      ["2024-03-01", "Checking", 33, "USD", 1.1, false, true],
    ]);

    for (const [counterpart, parent] of [
      [rows[0], rows[1]],
      [rows[3], rows[2]],
    ]) {
      expect(counterpart.linked).toBe(parent.id);
      const legs: {
        kind: string;
        amount: string;
        transfer_account: string | null;
        linked: string | null;
      }[] = await dataSource.query(
        `SELECT s.kind, s.amount, ta.name AS transfer_account,
                s.linked_transaction_id AS linked
           FROM transaction_splits s
           LEFT JOIN accounts ta ON ta.id = s.transfer_account_id
          WHERE s.transaction_id = $1 AND s.kind = 'transfer'`,
        [parent.id],
      );
      expect(legs).toHaveLength(1);
      expect(legs[0]).toMatchObject({
        transfer_account: "Checking",
        linked: counterpart.id,
      });
      expect(Number(legs[0].amount)).toBe(
        Math.sign(Number(parent.amount)) * 30,
      );
      // What `TransactionSplitService` stores for a line with a stated
      // received amount: received over sent, from the two stored amounts.
      expect(Number(counterpart.rate)).toBeCloseTo(
        Math.abs(Number(counterpart.amount)) / Math.abs(Number(legs[0].amount)),
        10,
      );
    }
    expect(await balanceOf("Checking")).toBe(0);
    expect(await balanceOf("EUR Savings")).toBe(0);
  });
});
