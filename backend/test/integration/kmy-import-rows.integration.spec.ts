import { DataSource } from "typeorm";
import { readKmyFixture } from "@/import/kmy/__fixtures__/kmy-fixtures";
import { useKmyImportHarness } from "../helpers/kmy-import-harness";

/**
 * The reference's section 18 file, read back from PostgreSQL row by row. The
 * expected values come from the file itself (docs/kmymoney-data-model.md
 * section 18) and the design record (docs/specs/kmymoney-import.md 5.x), not
 * from anything the importer printed.
 */
describe("kmy import: section 18 rows in the database (integration)", () => {
  const h = useKmyImportHarness();
  let dataSource: DataSource;
  let userId: string;

  beforeAll(() => {
    ({ dataSource, userId } = h);
  });

  beforeEach(async () => {
    const job = await h.runKmy(readKmyFixture("syntheticKmy"));
    expect(job.status).toBe("completed");
  });

  const query = <T>(sql: string, params: unknown[] = [userId]): Promise<T[]> =>
    dataSource.query(sql, params);

  interface TxRow {
    id: string;
    account: string;
    date: string;
    amount: string;
    is_transfer: boolean;
    is_split: boolean;
    linked: string | null;
    rate: string | null;
    status: string;
    reconciled: string | null;
    category: string | null;
    payee: string | null;
  }

  const txRows = (where = "TRUE"): Promise<TxRow[]> =>
    query<TxRow>(
      `SELECT t.id, a.name AS account, TO_CHAR(t.transaction_date, 'YYYY-MM-DD') AS date,
              t.amount, t.is_transfer, t.is_split,
              t.linked_transaction_id AS linked, t.exchange_rate AS rate,
              t.status, TO_CHAR(t.reconciled_date, 'YYYY-MM-DD') AS reconciled,
              c.name AS category, p.name AS payee
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
         LEFT JOIN payees p ON p.id = t.payee_id
        WHERE t.user_id = $1 AND ${where}
        ORDER BY t.transaction_date, a.name, t.amount`,
    );

  it("links every transfer's two legs to each other (T4, T5, T7)", async () => {
    const transfers = await txRows("t.is_transfer");
    expect(transfers.map((r) => [r.date, r.account, Number(r.amount)])).toEqual(
      [
        ["2024-01-10", "Checking", 100],
        ["2024-01-10", "Old Savings", -100],
        ["2024-01-15", "Checking", -1100],
        ["2024-01-15", "EUR Savings", 1000],
        ["2024-02-05", "Brokerage Account - Cash", 1000],
        ["2024-02-05", "Checking", -1000],
      ],
    );
    const byId = new Map(transfers.map((r) => [r.id, r]));
    for (const row of transfers) {
      expect(row.is_transfer).toBe(true);
      const other = byId.get(row.linked ?? "");
      expect(other).toBeDefined();
      // Each leg points at the other, which points back.
      expect(other?.linked).toBe(row.id);
      expect(other?.date).toBe(row.date);
      expect(other?.account).not.toBe(row.account);
    }
    // Same-currency pairs carry opposite amounts.
    for (const date of ["2024-01-10", "2024-02-05"]) {
      const pair = transfers.filter((r) => r.date === date);
      expect(pair).toHaveLength(2);
      expect(Number(pair[0].amount)).toBe(-Number(pair[1].amount));
    }
    // The cross-currency pair keeps each side in its own currency (5.6.4).
    const eur = transfers.find((r) => r.account === "EUR Savings");
    expect(Number(eur?.amount)).toBe(1000);
    expect(Number(eur?.rate)).toBeCloseTo(0.9090909091, 10);
  });

  it("writes the multi-split purchase as a split row whose legs sum to it (T3)", async () => {
    const [parent, ...others] = await txRows(
      "t.transaction_date = '2024-01-05'",
    );
    expect(others).toEqual([]);
    expect(parent).toMatchObject({
      account: "Checking",
      is_split: true,
      is_transfer: false,
      payee: "Corner Market",
    });
    expect(Number(parent.amount)).toBe(-120.5);

    const splits = await query<{
      kind: string;
      category: string | null;
      amount: string;
      memo: string | null;
      transfer_account_id: string | null;
    }>(
      `SELECT s.kind, c.name AS category, s.amount, s.memo, s.transfer_account_id
         FROM transaction_splits s
         LEFT JOIN categories c ON c.id = s.category_id
        WHERE s.transaction_id = $1
        ORDER BY s.amount`,
      [parent.id],
    );
    expect(
      splits.map((s) => [s.kind, s.category, Number(s.amount), s.memo]),
    ).toEqual([
      ["category", "Groceries", -100.5, "Food"],
      ["category", "Bank Fees", -20, "Card surcharge"],
    ]);
    expect(splits.reduce((sum, s) => sum + Number(s.amount), 0)).toBeCloseTo(
      Number(parent.amount),
      8,
    );
  });

  it("writes the sell with its exact amounts and leaves 15 shares at 25.25", async () => {
    const sells = await query<{
      quantity: string;
      total_amount: string;
      commission: string;
      price: string;
      date: string;
      symbol: string;
      account: string;
      cash_amount: string;
      cash_account: string;
    }>(
      `SELECT i.quantity, i.total_amount, i.commission, i.price,
              TO_CHAR(i.transaction_date, 'YYYY-MM-DD') AS date, s.symbol,
              a.name AS account, t.amount AS cash_amount, ta.name AS cash_account
         FROM investment_transactions i
         JOIN securities s ON s.id = i.security_id
         JOIN accounts a ON a.id = i.account_id
         JOIN transactions t ON t.id = i.transaction_id
         JOIN accounts ta ON ta.id = t.account_id
        WHERE i.user_id = $1 AND i.action = 'SELL'`,
    );
    expect(sells).toHaveLength(1);
    const [sell] = sells;
    expect(sell).toMatchObject({
      date: "2024-05-01",
      symbol: "EXC",
      account: "Brokerage Account - Brokerage",
      cash_account: "Brokerage Account - Cash",
    });
    expect(Number(sell.quantity)).toBe(5);
    expect(Number(sell.total_amount)).toBe(145);
    expect(Number(sell.commission)).toBe(5);
    expect(Number(sell.price)).toBe(30);
    expect(Number(sell.cash_amount)).toBe(145);

    // Monize stores no realised-gain column: what the sell leaves is the
    // holding. 505 over 20 post-split shares, 5 sold: 15 at 25.25 = 378.75.
    const held = await query<{ quantity: string; average_cost: string }>(
      `SELECT h.quantity, h.average_cost FROM holdings h
         JOIN accounts a ON a.id = h.account_id
        WHERE a.user_id = $1 AND h.quantity <> 0`,
    );
    expect(held).toHaveLength(1);
    expect(Number(held[0].quantity)).toBe(15);
    expect(Number(held[0].average_cost)).toBeCloseTo(25.25, 8);
  });

  it("writes the dividend as 7.50 in the cash account under Dividends", async () => {
    const dividends = await query<{
      total_amount: string;
      price: string | null;
      date: string;
      cash_amount: string;
      cash_account: string;
      category: string | null;
    }>(
      `SELECT i.total_amount, i.price,
              TO_CHAR(i.transaction_date, 'YYYY-MM-DD') AS date,
              t.amount AS cash_amount, ta.name AS cash_account, c.name AS category
         FROM investment_transactions i
         JOIN transactions t ON t.id = i.transaction_id
         JOIN accounts ta ON ta.id = t.account_id
         LEFT JOIN categories c ON c.id = t.category_id
        WHERE i.user_id = $1 AND i.action = 'DIVIDEND'`,
    );
    expect(dividends).toHaveLength(1);
    expect(dividends[0]).toMatchObject({
      date: "2024-03-15",
      cash_account: "Brokerage Account - Cash",
      category: "Dividends",
    });
    expect(Number(dividends[0].total_amount)).toBe(7.5);
    expect(Number(dividends[0].cash_amount)).toBe(7.5);
    expect(Number(dividends[0].price)).toBe(7.5);
    // 1000 - 505 + 7.50 + 145: the dividend is one of the four movements.
    expect(await h.balanceOf("Brokerage Account - Cash")).toBe(647.5);
  });

  it("stores the price history as 1 EXC = 50 then 30 USD, never inverted", async () => {
    const prices = await query<{
      date: string;
      close_price: string;
      source: string;
    }>(
      `SELECT TO_CHAR(p.price_date, 'YYYY-MM-DD') AS date, p.close_price, p.source
         FROM security_prices p JOIN securities s ON s.id = p.security_id
        WHERE s.symbol = 'EXC' ORDER BY p.price_date`,
      [],
    );
    expect(
      prices.map((p) => [p.date, Number(p.close_price), p.source]),
    ).toEqual([
      ["2024-02-10", 50, "kmy_import"],
      ["2024-05-01", 30, "kmy_import"],
    ]);
  });

  it("gives each row its own split's reconcile state (flag 2 -> RECONCILED, 1 -> CLEARED, 0 -> UNRECONCILED)", async () => {
    const groups = await query<{
      status: string;
      reconciled: string | null;
      n: string;
    }>(
      `SELECT status, TO_CHAR(reconciled_date, 'YYYY-MM-DD') AS reconciled,
              count(*) AS n
         FROM transactions WHERE user_id = $1
        GROUP BY 1, 2 ORDER BY 1, 2`,
    );
    // 11 rows (the two folded opening balances write none). T3 and the
    // Checking sides of T4 and T5 carry flag 2 and 2024-01-31; T6 is flag 1;
    // the other seven rows are flag 0.
    expect(groups.map((g) => [g.status, g.reconciled, Number(g.n)])).toEqual([
      ["CLEARED", null, 1],
      ["RECONCILED", "2024-01-31", 3],
      ["UNRECONCILED", null, 7],
    ]);

    const rows = await txRows("t.status <> 'UNRECONCILED'");
    expect(
      rows.map((r) => [r.date, r.account, r.status, Number(r.amount)]),
    ).toEqual([
      ["2024-01-05", "Checking", "RECONCILED", -120.5],
      ["2024-01-10", "Checking", "RECONCILED", 100],
      ["2024-01-15", "Checking", "RECONCILED", -1100],
      ["2024-02-01", "Checking", "CLEARED", -75],
    ]);

    const trades = await query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM investment_transactions
        WHERE user_id = $1 GROUP BY 1`,
    );
    expect(trades.map((t) => [t.status, Number(t.n)])).toEqual([
      ["UNRECONCILED", 4],
    ]);
  });

  it("writes the schedule as an active, never-auto-posting monthly bill due 2024-03-01", async () => {
    const schedules = await query<{
      name: string;
      frequency: string;
      next_due: string;
      start_date: string;
      amount: string;
      auto_post: boolean;
      is_active: boolean;
      is_transfer: boolean;
      account: string;
      category: string | null;
      payee_id: string | null;
      payee: string | null;
      currency_code: string;
    }>(
      `SELECT st.name, st.frequency, TO_CHAR(st.next_due_date, 'YYYY-MM-DD') AS next_due,
              TO_CHAR(st.start_date, 'YYYY-MM-DD') AS start_date, st.amount,
              st.auto_post, st.is_active, st.is_transfer, a.name AS account,
              c.name AS category, st.payee_id, p.name AS payee, st.currency_code
         FROM scheduled_transactions st
         JOIN accounts a ON a.id = st.account_id
         LEFT JOIN categories c ON c.id = st.category_id
         LEFT JOIN payees p ON p.id = st.payee_id
        WHERE st.user_id = $1`,
    );
    // Spec 5.10.2/5.10.3: Monthly x1 -> MONTHLY; next due = the template's
    // post date; Checking -75 to Electricity, payee City Power.
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      name: "Electricity",
      frequency: "MONTHLY",
      next_due: "2024-03-01",
      auto_post: false,
      is_active: true,
      is_transfer: false,
      account: "Checking",
      category: "Electricity",
      payee: "City Power",
      currency_code: "USD",
    });
    expect(Number(schedules[0].amount)).toBe(-75);
  });

  it("folds the equity opening balances into accounts.opening_balance and writes no row for them", async () => {
    const accounts = await query<{ name: string; opening: string }>(
      `SELECT name, opening_balance AS opening FROM accounts
        WHERE user_id = $1 AND name IN ('Checking', 'Old Savings')
        ORDER BY name`,
    );
    expect(accounts.map((a) => [a.name, Number(a.opening)])).toEqual([
      ["Checking", 5000],
      ["Old Savings", 100],
    ]);

    // Checking holds exactly T3, T4, T5, T6 and T7 (five rows): none of them
    // is the 5000 opening balance, none is dated 2024-01-01.
    const checking = await txRows("a.name = 'Checking'");
    expect(checking.map((r) => [r.date, Number(r.amount)])).toEqual([
      ["2024-01-05", -120.5],
      ["2024-01-10", 100],
      ["2024-01-15", -1100],
      ["2024-02-01", -75],
      ["2024-02-05", -1000],
    ]);
    expect(await txRows("t.transaction_date = '2024-01-01'")).toEqual([]);
    expect(
      await query(
        `SELECT 1 FROM categories WHERE user_id = $1 AND name = 'Opening Balances'`,
      ),
    ).toEqual([]);
    // 5000 + (-120.5 + 100 - 1100 - 75 - 1000) = 2804.5
    expect(await h.balanceOf("Checking")).toBe(2804.5);
  });

  it("puts the household tag on exactly the Groceries leg the file tags", async () => {
    const tags = await query<{ name: string }>(
      `SELECT name FROM tags WHERE user_id = $1`,
    );
    expect(tags.map((t) => t.name)).toEqual(["household"]);

    const tagged = await query<{
      tag: string;
      category: string | null;
      amount: string;
      memo: string | null;
    }>(
      `SELECT g.name AS tag, c.name AS category, s.amount, s.memo
         FROM transaction_split_tags st
         JOIN tags g ON g.id = st.tag_id
         JOIN transaction_splits s ON s.id = st.transaction_split_id
         LEFT JOIN categories c ON c.id = s.category_id`,
      [],
    );
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toMatchObject({
      tag: "household",
      category: "Groceries",
      memo: "Food",
    });
    expect(Number(tagged[0].amount)).toBe(-100.5);

    // The file tags no whole transaction, so no transaction-level tag rows.
    expect(
      await query(
        `SELECT 1 FROM transaction_tags tt JOIN tags g ON g.id = tt.tag_id
          WHERE g.user_id = $1`,
      ),
    ).toEqual([]);
  });
});
