import { DataSource } from "typeorm";
import {
  kmyAccount,
  kmyFile,
  kmyPayee,
  kmySplit,
  kmyTransaction,
  kmyTxId,
  toKmyBytes,
} from "@/import/kmy/__fixtures__/kmy-xml-builders";
import { useKmyImportHarness } from "../helpers/kmy-import-harness";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";

/**
 * An import WITHOUT "start fresh": the user already has an account, a category
 * and a payee that the file also names, differing only in case. The writers
 * find-or-create by lower-cased name (write-reference.ts), so the file's rows
 * land in the user's own rows and nothing of the user's is replaced, renamed
 * or duplicated; a reused account's balance stays the ledger's, recomputed
 * from its rows (mny-import.service.ts), not overwritten by the file's figure.
 */
describe("kmy import: into existing data (integration)", () => {
  const h = useKmyImportHarness();
  let dataSource: DataSource;
  let userId: string;

  beforeAll(() => {
    ({ dataSource, userId } = h);
  });

  const leg = (id: string, account: string, value: string, payee?: string) =>
    kmySplit({ id, account, value: `${value}/1`, shares: `${value}/1`, payee });

  /** File: Checking opens at 1000 and pays 40 to Water for Corner Market. */
  const file = () =>
    kmyFile({
      accounts: [
        kmyAccount({ id: "A000001", name: "Checking", type: 1 }),
        kmyAccount({
          id: "A000005",
          name: "Water",
          type: 13,
          parentaccount: "AStd::Expense",
        }),
        kmyAccount(
          {
            id: "A000099",
            name: "Opening Balances",
            type: 16,
            parentaccount: "AStd::Equity",
          },
          { kvp: { OpeningBalanceAccount: "Yes" } },
        ),
      ],
      payees: [kmyPayee({ id: "P000001", name: "Corner Market" })],
      transactions: [
        kmyTransaction(
          [leg("S0001", "A000001", "1000"), leg("S0002", "A000099", "-1000")],
          { id: kmyTxId(1), postdate: "2024-01-01" },
        ),
        kmyTransaction(
          [
            leg("S0001", "A000001", "-40", "P000001"),
            leg("S0002", "A000005", "40", "P000001"),
          ],
          { id: kmyTxId(2), postdate: "2024-01-10" },
        ),
      ],
    });

  it("lands the file's rows in the existing account, category and payee and leaves the user's own rows intact", async () => {
    const existing = await createTestAccount(dataSource, userId, {
      name: "checking",
      openingBalance: 200,
      currentBalance: 170,
    });
    const category = await createTestCategory(dataSource, userId, {
      name: "water",
    });
    const payee = await createTestPayee(dataSource, userId, {
      name: "corner market",
    });
    const own: { id: string }[] = await dataSource.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code, exchange_rate, description, status)
       VALUES ($1, $2, '2023-12-01', -30, 'USD', 1, 'my own row', 'UNRECONCILED')
       RETURNING id`,
      [userId, existing.id],
    );

    const job = await h.runKmy(toKmyBytes(file(), "gzip"));

    expect(job.status).toBe("completed");
    // Nothing of the user's was duplicated: the three are matched, not created.
    expect(job.result).toMatchObject({
      accountsCreated: 0,
      categoriesCreated: 0,
      payeesCreated: 0,
      transactionsCreated: 1,
    });
    const count = async (table: string): Promise<number> =>
      Number(
        (
          await dataSource.query(
            `SELECT count(*) AS n FROM ${table} WHERE user_id = $1`,
            [userId],
          )
        )[0].n,
      );
    expect(await count("accounts")).toBe(1);
    expect(await count("payees")).toBe(1);
    // The file's Water is the user's "water": one category, its name kept.
    const categories: { id: string; name: string }[] = await dataSource.query(
      `SELECT id, name FROM categories WHERE user_id = $1`,
      [userId],
    );
    expect(categories).toEqual([{ id: category.id, name: "water" }]);

    // The user's account keeps its own name and opening balance: the file's
    // 1000 opening balance is not applied to an account it did not create.
    const accounts: {
      id: string;
      name: string;
      opening_balance: string;
      current_balance: string;
    }[] = await dataSource.query(
      `SELECT id, name, opening_balance, current_balance FROM accounts WHERE user_id = $1`,
      [userId],
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: existing.id, name: "checking" });
    expect(Number(accounts[0].opening_balance)).toBe(200);

    // The user's row survives untouched; the file's Water row joins it, on
    // the existing category and payee.
    const rows: {
      id: string;
      date: string;
      amount: string;
      description: string | null;
      category_id: string | null;
      payee_id: string | null;
      account_id: string;
    }[] = await dataSource.query(
      `SELECT id, TO_CHAR(transaction_date, 'YYYY-MM-DD') AS date, amount,
              description, category_id, payee_id, account_id
         FROM transactions WHERE user_id = $1 ORDER BY transaction_date`,
      [userId],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: own[0].id,
      date: "2023-12-01",
      description: "my own row",
      category_id: null,
      payee_id: null,
      account_id: existing.id,
    });
    expect(Number(rows[0].amount)).toBe(-30);
    expect(rows[1]).toMatchObject({
      date: "2024-01-10",
      category_id: category.id,
      payee_id: payee.id,
      account_id: existing.id,
    });
    expect(Number(rows[1].amount)).toBe(-40);

    // The balance is the ledger's: 200 (the user's opening) - 30 - 40.
    expect(Number(accounts[0].current_balance)).toBe(130);
    expect(await h.balanceOf("checking")).toBe(130);
    // The report is honest about it: the file's own figure is 960.
    const line = job.result!.verification.find(
      (v) => v.accountName === "Checking",
    );
    expect(line).toMatchObject({
      expectedBalance: 960,
      importedBalance: 130,
    });
  });
});
