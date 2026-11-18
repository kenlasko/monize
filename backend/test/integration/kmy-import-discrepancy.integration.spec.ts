import type { MnyParsedFile } from "@/import/mny/mny-parser.service";
import {
  kmyAccount,
  kmyCurrency,
  kmyFile,
  kmySplit,
  kmyTransaction,
  kmyTxId,
  toKmyBytes,
} from "@/import/kmy/__fixtures__/kmy-xml-builders";
import { DataSource } from "typeorm";
import { useKmyImportHarness } from "../helpers/kmy-import-harness";

/**
 * Two paths whose figures must not be papered over: a verification line whose
 * mapped rows disagree with the file's own balance (spec 6.3), and a
 * cross-currency transfer the file gives no rate for (spec 5.6.4).
 */
describe("kmy import: discrepancy and missing-rate paths (integration)", () => {
  /** When set, the wrapped parser returns the parse result through this. */
  let alter: ((parsed: MnyParsedFile) => MnyParsedFile) | null = null;
  const h = useKmyImportHarness({
    wrapParser: (real) => ({
      sourceFormat: "kmy",
      parse: async (input) => {
        const parsed = await real.parse(input);
        return alter ? alter(parsed) : parsed;
      },
    }),
  });
  let dataSource: DataSource;
  let userId: string;

  beforeAll(() => {
    ({ dataSource, userId } = h);
  });

  afterEach(() => {
    alter = null;
  });

  const leg = (id: string, account: string, value: string, shares = value) =>
    kmySplit({ id, account, value: `${value}/1`, shares: `${shares}/1` });

  const equity = kmyAccount(
    {
      id: "A000099",
      name: "Opening Balances",
      type: 16,
      parentaccount: "AStd::Equity",
    },
    { kvp: { OpeningBalanceAccount: "Yes" } },
  );

  it("reports the file figure, the altered mapped figure, the database figure and the delta", async () => {
    // Checking opens at 1000 and pays 40 for water: the file says 960.
    const xml = kmyFile({
      accounts: [
        kmyAccount({ id: "A000001", name: "Checking", type: 1 }),
        kmyAccount({
          id: "A000005",
          name: "Water",
          type: 13,
          parentaccount: "AStd::Expense",
        }),
        equity,
      ],
      transactions: [
        kmyTransaction(
          [leg("S0001", "A000001", "1000"), leg("S0002", "A000099", "-1000")],
          { id: kmyTxId(1), postdate: "2024-01-01" },
        ),
        kmyTransaction(
          [leg("S0001", "A000001", "-40"), leg("S0002", "A000005", "40")],
          { id: kmyTxId(2), postdate: "2024-01-10" },
        ),
      ],
    });

    // A mapper that mis-sums the water row by 7.25: the real parse runs, then
    // the one mapped row and the mapper's own balance move by the same delta,
    // while the file's own figure (`fileBalances`) is left alone.
    const bump = -7.25;
    alter = (parsed) => {
      const checking = parsed.accounts.accounts.find(
        (account) => account.name === "Checking",
      )!;
      let altered = 0;
      const transactions = parsed.transactions.transactions.map((row) => {
        if (row.accountKey === checking.key && row.amount === -40) {
          altered += 1;
          return { ...row, amount: row.amount + bump };
        }
        return row;
      });
      expect(altered).toBe(1);
      const expectedBalances = new Map(parsed.expectedBalances);
      expectedBalances.set(
        checking.key,
        (expectedBalances.get(checking.key) ?? 0) + bump,
      );
      return {
        ...parsed,
        transactions: { ...parsed.transactions, transactions },
        expectedBalances,
      };
    };

    const job = await h.runKmy(toKmyBytes(xml, "gzip"));

    expect(job.status).toBe("completed");
    const lines = job.result!.verification;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      accountName: "Checking",
      expectedBalance: 960,
      mappedBalance: 952.75,
      importedBalance: 952.75,
      delta: -7.25,
      matches: false,
    });
    // What the database holds is the altered figure, not the file's.
    expect(await h.balanceOf("Checking")).toBe(952.75);
    const rows: { amount: string }[] = await dataSource.query(
      `SELECT amount FROM transactions WHERE user_id = $1`,
      [userId],
    );
    expect(rows.map((r) => Number(r.amount))).toEqual([-47.25]);
  });

  it("stores a cross-currency transfer with no rate as null, never 1, and warns", async () => {
    // USD Checking pays 100 USD; the EUR side's shares are 0, so the two
    // amounts imply no rate, and the file holds no EUR/USD price.
    const xml = kmyFile({
      accounts: [
        kmyAccount({ id: "A000001", name: "Checking", type: 1 }),
        kmyAccount({
          id: "A000002",
          name: "EUR Savings",
          type: 2,
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
            leg("S0001", "A000001", "-100"),
            kmySplit({
              id: "S0002",
              account: "A000002",
              value: "100/1",
              shares: "0/1",
              price: "0/1",
            }),
          ],
          { id: kmyTxId(1), postdate: "2024-02-01" },
        ),
      ],
    });

    const job = await h.runKmy(toKmyBytes(xml, "gzip"));

    expect(job.status).toBe("completed");
    expect(await dataSource.query(`SELECT 1 FROM exchange_rates`)).toHaveLength(
      0,
    );

    const rows: {
      account: string;
      amount: string;
      rate: string | null;
      is_transfer: boolean;
    }[] = await dataSource.query(
      `SELECT a.name AS account, t.amount, t.exchange_rate AS rate, t.is_transfer
         FROM transactions t JOIN accounts a ON a.id = t.account_id
        WHERE t.user_id = $1 ORDER BY a.name`,
      [userId],
    );
    expect(rows).toHaveLength(2);
    const eur = rows.find((r) => r.account === "EUR Savings")!;
    const usd = rows.find((r) => r.account === "Checking")!;
    expect(eur.is_transfer).toBe(true);
    expect(Number(eur.amount)).toBe(0);
    // The receiving row has no rate: null, not 1.
    expect(eur.rate).toBeNull();
    expect(Number(usd.amount)).toBe(-100);

    const warning = job.result!.warnings.find(
      (w) => w.code === "crossCurrencyTransferRateMissing",
    );
    expect(warning).toBeDefined();
    expect(warning).toMatchObject({ count: 1 });
  });
});
