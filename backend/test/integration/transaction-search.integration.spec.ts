import { TestingModule } from "@nestjs/testing";
import { DataSource, SelectQueryBuilder } from "typeorm";

import { Account } from "@/accounts/entities/account.entity";
import { Tag } from "@/tags/entities/tag.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { withUserContext } from "@/common/db/with-context";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionAnalyticsService } from "@/transactions/transaction-analytics.service";
import { TransactionBulkUpdateService } from "@/transactions/transaction-bulk-update.service";
import { applyParsedSearch } from "@/transactions/apply-transaction-search";
import { parseTransactionSearch } from "@/transactions/transaction-search-query.util";
import {
  referenceKey,
  referenceKeySql,
  SearchGrain,
} from "@/transactions/transaction-search.util";
import {
  cleanTables,
  createIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * The search clause builder against real PostgreSQL: the truth tables of
 * `docs/specs/advanced-search.md` section 8 at both grains, the
 * reference key's SQL against its TypeScript twin, and INV-SEARCH-002 --
 * a single bare term finds exactly the transactions the single-term clause
 * every call site uses today finds.
 *
 * The truth tables run through plain query builders shaped like the two
 * grains; the call-site cases at the end run the register, the LLM summary
 * and bulk update themselves, all of which search at split grain.
 */
describe("transaction search (integration)", () => {
  const EN = { numberFormat: "en-US", dateFormat: "YYYY-MM-DD" };

  let module: TestingModule;
  let dataSource: DataSource;
  let userId: string;
  let refAccount: Account;
  let splitAccount: Account;
  let promoAccount: Account;
  let taggedAccount: Account;
  let pendingAccount: Account;
  /** Transaction id -> fixture label. */
  const labels = new Map<string, string>();
  /** Split id -> fixture label ("S/Gas"). */
  const splitLabels = new Map<string, string>();

  beforeAll(async () => {
    module = await createIntegrationModule([TransactionsModule]);
    dataSource = module.get(DataSource);

    await cleanTables(dataSource, [
      "transaction_splits",
      "transactions",
      "categories",
      "accounts",
      "users",
    ]);
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    refAccount = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      currencyCode: "USD",
    });
    splitAccount = await createTestAccount(dataSource, userId, {
      name: "Visa",
      currencyCode: "USD",
    });
    promoAccount = await createTestAccount(dataSource, userId, {
      name: "Promo",
      currencyCode: "USD",
    });
    taggedAccount = await createTestAccount(dataSource, userId, {
      name: "Tagged",
      currencyCode: "USD",
    });
    pendingAccount = await createTestAccount(dataSource, userId, {
      name: "Euro Savings",
      currencyCode: "USD",
    });
    const groceries = await createTestCategory(dataSource, userId, {
      name: "Groceries",
    });
    const gas = await createTestCategory(dataSource, userId, { name: "Gas" });

    const save = async (
      label: string,
      fields: Partial<Transaction>,
    ): Promise<Transaction> => {
      const row = await dataSource.manager.save(
        dataSource.manager.create(Transaction, {
          userId,
          currencyCode: "USD",
          transactionDate: "2026-03-10",
          ...fields,
        }),
      );
      labels.set(row.id, label);
      return row;
    };

    // Section 8, references.
    await save("A", {
      accountId: refAccount.id,
      referenceNumber: "10",
      amount: -50,
      transactionDate: "2026-03-15",
    });
    await save("B", {
      accountId: refAccount.id,
      referenceNumber: "100",
      amount: -75,
    });
    await save("C", {
      accountId: refAccount.id,
      referenceNumber: "0010",
      amount: -20,
    });
    await save("D", {
      accountId: refAccount.id,
      referenceNumber: "A10",
      amount: -30,
    });
    await save("E", { accountId: refAccount.id, amount: -10 });
    await save("F", {
      accountId: refAccount.id,
      amount: -40,
      description: "Invoice 10",
    });

    // Section 8, words and splits.
    const s = await save("S", {
      accountId: splitAccount.id,
      payeeName: "Costco",
      amount: -100,
      isSplit: true,
    });
    for (const [label, categoryId, amount, memo] of [
      ["S/Groceries", groceries.id, -80, "Lunch run"],
      ["S/Gas", gas.id, -20, null],
    ] as const) {
      const split = await dataSource.manager.save(
        dataSource.manager.create(TransactionSplit, {
          transactionId: s.id,
          categoryId,
          amount,
          memo,
        }),
      );
      splitLabels.set(split.id, label);
    }
    await save("P", {
      accountId: splitAccount.id,
      payeeName: "Costco Gas Bar",
      categoryId: gas.id,
      amount: -60,
    });

    // LIKE metacharacters in the text itself (INV-SEARCH-005).
    await save("Q50", {
      accountId: promoAccount.id,
      description: "50% off",
      amount: -5,
    });
    // Two tags that both match "fuel", for INV-SEARCH-004.
    const fuelRow = await save("T", {
      accountId: taggedAccount.id,
      amount: -60,
    });
    for (const name of ["fuel", "fuel card"]) {
      const tag = await dataSource.manager.save(
        dataSource.manager.create(Tag, { userId, name }),
      );
      await dataSource.query(
        "INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)",
        [fuelRow.id, tag.id],
      );
    }

    // A provisional transfer leg beside a confirmed one and an ordinary row
    // (provisional-amounts plan, decision 6). The confirmed leg's description
    // carries the old note text, so the search reads the column, not the text.
    await save("PV", {
      accountId: pendingAccount.id,
      amount: 80,
      isTransfer: true,
      amountIsProvisional: true,
    });
    await save("CF", {
      accountId: pendingAccount.id,
      amount: 90,
      isTransfer: true,
      description: "PENDING IMPORT: Amount may need adjustment",
    });
    await save("OR", { accountId: pendingAccount.id, amount: -15 });

    await save("Q500", {
      accountId: promoAccount.id,
      description: "500 off",
      amount: -7,
    });
  });

  afterAll(async () => {
    await module.close();
  });

  function transactionQuery(
    alias: string,
    accountId: string,
  ): SelectQueryBuilder<Transaction> {
    return dataSource
      .getRepository(Transaction)
      .createQueryBuilder(alias)
      .select(`${alias}.id`, "id")
      .where(`${alias}.userId = :userId`, { userId })
      .andWhere(`${alias}.accountId = :accountId`, { accountId });
  }

  async function transactionsMatching(
    input: string,
    accountId: string,
    alias = "transaction",
  ): Promise<string[]> {
    const qb = transactionQuery(alias, accountId);
    applyParsedSearch(qb, parseTransactionSearch(input, EN), {
      transaction: alias,
      grain: "transaction",
      paramPrefix: "srch",
    });
    const rows: Array<{ id: string }> = await qb.getRawMany();
    return rows.map((row) => labels.get(row.id) as string).sort();
  }

  /** Rows of a transaction joined to its splits; a row with no split is its transaction's label. */
  async function splitRowsMatching(input: string): Promise<string[]> {
    const qb = dataSource
      .getRepository(Transaction)
      .createQueryBuilder("t")
      .leftJoin("t.splits", "ts")
      .select("t.id", "tid")
      .addSelect("ts.id", "sid")
      .where("t.userId = :userId", { userId })
      .andWhere("t.accountId = :accountId", { accountId: splitAccount.id });
    applyParsedSearch(qb, parseTransactionSearch(input, EN), {
      transaction: "t",
      splits: "ts",
      grain: "split" satisfies SearchGrain,
      paramPrefix: "srch",
    });
    const rows: Array<{ tid: string; sid: string | null }> =
      await qb.getRawMany();
    return rows
      .map((row) =>
        row.sid
          ? (splitLabels.get(row.sid) as string)
          : (labels.get(row.tid) as string),
      )
      .sort();
  }

  describe("references (plan section 8)", () => {
    it.each<[string, string[]]>([
      ["10", ["A", "B", "C", "D", "E", "F"]],
      ["ref:10", ["A", "B", "C", "D"]],
      ["ref:=10", ["A", "C"]],
      ["#10", ["A", "C"]],
      ["#0010", ["A", "C"]],
      ["ref:10*", ["A", "B"]],
      ["has:ref -ref:=10", ["B", "D"]],
      ["amount:=10", ["E"]],
      ["memo:10", ["F"]],
      ["ref:", ["A", "B", "C", "D", "E", "F"]],
      ["date:2026-03-15", ["A"]],
      ["date:2026-03", ["A", "B", "C", "D", "E", "F"]],
      ["date:<2026-03-15", ["B", "C", "D", "E", "F"]],
      ["amount:20..50", ["A", "C", "D", "F"]],
      ["-memo:invoice", ["A", "B", "C", "D", "E"]],
      ["is:uncategorized", ["A", "B", "C", "D", "E", "F"]],
      ["status:unreconciled", ["A", "B", "C", "D", "E", "F"]],
      ["has:attachment", []],
      ["has:warranty", []],
      ["account:chequing", ["A", "B", "C", "D", "E", "F"]],
      ["10 -account:chequing", []],
    ])("%j", async (input, expected) => {
      await expect(transactionsMatching(input, refAccount.id)).resolves.toEqual(
        expected,
      );
    });
  });

  describe("words and splits (plan section 8)", () => {
    it.each<[string, string[], string[]]>([
      ["costco gas", ["P", "S"], ["P", "S/Gas"]],
      ['"costco gas"', ["P"], ["P"]],
      ["cat:groceries cat:gas", ["S"], []],
      ["costco -cat:gas", [], ["S/Groceries"]],
      ["amount:>90", ["S"], ["S/Gas", "S/Groceries"]],
      ["amount:=20", ["S"], ["S/Gas"]],
      ["is:split", ["S"], ["S/Gas", "S/Groceries"]],
      ['payee:="costco"', ["S"], ["S/Gas", "S/Groceries"]],
    ])("%j", async (input, transactionGrain, splitGrain) => {
      await expect(
        transactionsMatching(input, splitAccount.id),
      ).resolves.toEqual(transactionGrain);
      await expect(splitRowsMatching(input)).resolves.toEqual(splitGrain);
    });
  });

  describe("is:provisional (provisional-amounts plan, decision 6)", () => {
    it.each<[string, string[]]>([
      ["is:provisional", ["PV"]],
      ["-is:provisional", ["CF", "OR"]],
      ["is:transfer -is:provisional", ["CF"]],
    ])("%j", async (input, expected) => {
      await expect(
        transactionsMatching(input, pendingAccount.id),
      ).resolves.toEqual(expected);
    });
  });

  it.each(["transaction", "t", "bf"])(
    "every field and operator is valid SQL under the alias %j",
    async (alias) => {
      // Each query stays within the 12-term cap and starts with a term that
      // matches nothing, so every arm is planned and executed on an empty
      // result.
      for (const query of [
        "nomatch payee:x memo:=x cat:x* tag:x account:x ref:=x #1",
        "nomatch status:void is:transfer is:uncategorized is:provisional has:attachment has:warranty has:memo has:tag has:ref",
      ]) {
        await expect(
          transactionsMatching(query, refAccount.id, alias),
        ).resolves.toEqual([]);
      }
      await expect(
        transactionsMatching(
          "amount:>1 amount:1..2 date:2026 date:>=2026-03-15 -is:split",
          refAccount.id,
          alias,
        ),
      ).resolves.toEqual([]);
    },
  );

  describe("INV-SEARCH-002: a single bare term matches what it matched before the syntax", () => {
    // Recorded 2026-10-12 against the single-term `buildTransactionSearchClause`
    // (task B2's spec compared the two live; B3 removed the old clause). Each
    // row is [term, reference account, split account].
    it.each<[string, string[], string[]]>([
      ["10", ["A", "B", "C", "D", "E", "F"], ["S"]],
      ["0010", ["C", "E"], []],
      ["100", ["B"], ["S"]],
      ["-10", ["E"], ["S"]],
      ["20", ["C"], ["S"]],
      ["80.00", [], ["S"]],
      ["costco", [], ["P", "S"]],
      ["gas", [], ["P", "S"]],
      ["groceries", [], ["S"]],
      ["invoice", ["F"], []],
      ["2026-03-15", ["A"], []],
      ["%", [], []],
      ["_", [], []],
      ["co_tco", [], []],
      ["\\", [], []],
      ["nothing-matches", [], []],
    ])("%j", async (term, refRows, splitRows) => {
      await expect(transactionsMatching(term, refAccount.id)).resolves.toEqual(
        refRows,
      );
      await expect(
        transactionsMatching(term, splitAccount.id),
      ).resolves.toEqual(splitRows);
    });
  });

  describe("call sites", () => {
    async function register(accountId: string, search: string) {
      return withUserContext(userId, () =>
        module
          .get(TransactionsService)
          .findAll(
            userId,
            [accountId],
            undefined,
            undefined,
            undefined,
            undefined,
            1,
            50,
            false,
            search,
          ),
      );
    }

    it("has:warranty finds, and warrantyCount counts, the same unarchived warranties", async () => {
      const idOf = (label: string) =>
        [...labels.entries()].find(([, l]) => l === label)?.[0] as string;
      const insertWarranty = (transactionId: string, archived: boolean) =>
        dataSource.query(
          `INSERT INTO warranties (user_id, name, purchase_date, is_lifetime, transaction_id, archived_at)
           VALUES ($1, 'Kettle', '2026-03-10', true, $2, ${archived ? "NOW()" : "NULL"})`,
          [userId, transactionId],
        );
      await insertWarranty(idOf("A"), false);
      await insertWarranty(idOf("A"), true);
      // Only archived: put away, so neither the search nor the badge sees it.
      await insertWarranty(idOf("B"), true);
      try {
        const found = await register(refAccount.id, "has:warranty");
        expect(found.data.map((row) => labels.get(row.id))).toEqual(["A"]);

        const without = await register(refAccount.id, "-has:warranty");
        expect(without.data.map((row) => labels.get(row.id)).sort()).toEqual([
          "B",
          "C",
          "D",
          "E",
          "F",
        ]);

        const page = await register(refAccount.id, "");
        const counts = Object.fromEntries(
          page.data.map((row) => [labels.get(row.id), row.warrantyCount]),
        );
        expect(counts).toEqual({ A: 1, B: 0, C: 0, D: 0, E: 0, F: 0 });
      } finally {
        await dataSource.query("DELETE FROM warranties WHERE user_id = $1", [
          userId,
        ]);
      }
    });

    it("the register finds cheque 10 by #10", async () => {
      const page = await register(refAccount.id, "#10");
      expect(page.data.map((row) => labels.get(row.id)).sort()).toEqual([
        "A",
        "C",
      ]);
      expect(page.pagination.total).toBe(2);
    });

    it("the register draws only the matching line of a split (split grain)", async () => {
      const page = await register(splitAccount.id, "memo:lunch");
      expect(page.data.map((row) => labels.get(row.id))).toEqual(["S"]);
      expect(
        page.data[0].splits.map((split) => splitLabels.get(split.id)),
      ).toEqual(["S/Groceries"]);
    });

    it("every term must hold on the same line of the register", async () => {
      const page = await register(splitAccount.id, "costco gas");
      const byLabel = new Map(
        page.data.map((row) => [labels.get(row.id), row]),
      );
      expect([...byLabel.keys()].sort()).toEqual(["P", "S"]);
      expect(
        byLabel.get("S")?.splits.map((split) => splitLabels.get(split.id)),
      ).toEqual(["S/Gas"]);
    });

    it("the LLM totals and the register agree on a LIKE metacharacter (INV-SEARCH-005)", async () => {
      const totals = await withUserContext(userId, () =>
        module.get(TransactionAnalyticsService).getLlmListTransactions(userId, {
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          accountIds: [promoAccount.id],
          searchText: "50%",
        }),
      );
      const page = await register(promoAccount.id, "50%");
      expect(page.data.map((row) => labels.get(row.id))).toEqual(["Q50"]);
      expect(totals.transactionCount).toBe(1);
      expect(totals.totalExpenses).toBe(5);
    });

    it("two matching tags do not count a transaction twice (INV-SEARCH-004)", async () => {
      const totals = await withUserContext(userId, () =>
        module.get(TransactionAnalyticsService).getLlmListTransactions(userId, {
          startDate: "2026-01-01",
          endDate: "2026-12-31",
          accountIds: [taggedAccount.id],
          searchText: "fuel",
        }),
      );
      const page = await register(taggedAccount.id, "tag:fuel");
      expect(page.pagination.total).toBe(1);
      expect(totals.transactionCount).toBe(1);
      expect(totals.totalExpenses).toBe(60);
    });

    it("bulk update searches with an uncategorized-only category filter", async () => {
      // The category filter joins no split alias for the pseudo-ids alone, so
      // the search joins its own; before B3 this query named an alias that
      // was never joined.
      const result = await withUserContext(userId, () =>
        module.get(TransactionBulkUpdateService).bulkUpdate(userId, {
          mode: "filter",
          filters: {
            accountIds: [promoAccount.id],
            categoryIds: ["uncategorized"],
            search: "off -memo:50%",
          },
          payeeName: "Promo Shop",
        }),
      );
      expect(result.updated).toBe(1);
      const rows = await dataSource.manager.find(Transaction, {
        where: { accountId: promoAccount.id },
      });
      expect(
        rows.map((row) => [labels.get(row.id), row.payeeName]).sort(),
      ).toEqual([
        ["Q50", null],
        ["Q500", "Promo Shop"],
      ]);
    });
  });

  it("the reference key's SQL equals its TypeScript twin", async () => {
    const values = [
      "10",
      "0010",
      "#10",
      "#0010",
      " 10 ",
      "A10",
      "a010",
      "0",
      "000",
      "#",
      "##10",
      "Ab#1",
    ];
    const rows: Array<{ ref: string; key: string }> = await dataSource.query(
      `SELECT v.ref, ${referenceKeySql("v.ref")} AS key FROM unnest($1::text[]) AS v(ref)`,
      [values],
    );
    expect(rows.map((row) => [row.ref, row.key])).toEqual(
      values.map((value) => [value, referenceKey(value)]),
    );
  });
});
