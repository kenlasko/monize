import { SharedReviewService } from "@/shared-expenses/shared-review.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { TransactionRulesService } from "@/transaction-rules/transaction-rules.service";
import { BuiltInReportsModule } from "@/built-in-reports/built-in-reports.module";
import { SpendingReportsService } from "@/built-in-reports/spending-reports.service";
import { IncomeReportsService } from "@/built-in-reports/income-reports.service";
import {
  queryCategorySpending,
  resolveCategorySpentOrNull,
} from "@/budgets/budget-spending.util";
import { BudgetCategory } from "@/budgets/entities/budget-category.entity";
import { Transaction } from "@/transactions/entities/transaction.entity";
import { TransactionSplit } from "@/transactions/entities/transaction-split.entity";
import { withScopedDb } from "@/common/db/scoped-db";
import { randomUUID } from "crypto";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { withUserContext } from "@/common/db/with-context";
import { ExchangeRateService } from "@/currencies/exchange-rate.service";
import { SharedExpensesModule } from "@/shared-expenses/shared-expenses.module";
import { SharedGroupsService } from "@/shared-expenses/shared-groups.service";
import { SharedEntriesService } from "@/shared-expenses/shared-entries.service";
import { SharedFinanceService } from "@/shared-expenses/shared-finance.service";
import { SharedEntryFinanceService } from "@/shared-expenses/shared-entry-finance.service";
import { SaveSharedEntryFinanceDto } from "@/shared-expenses/dto/shared-entry-finance.dto";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";
import {
  EnforcedIntegrationHarness,
  cleanTables,
  createEnforcedIntegrationModule,
  createTestUserDirect,
} from "../helpers/integration-setup";

describe("Shared entry and personal booking commit under enforced RLS", () => {
  jest.setTimeout(120000);
  let h: EnforcedIntegrationHarness;
  let groups: SharedGroupsService;
  let entries: SharedEntriesService;
  let finance: SharedFinanceService;
  let combined: SharedEntryFinanceService;
  let user: string,
    groupId: string,
    accountId: string,
    settlementId: string,
    categoryId: string;
  let dto: SaveSharedEntryFinanceDto;
  let bankIds: string[];
  const asOwner = <T>(fn: () => Promise<T>) => withUserContext(user, fn);
  const command = (expectedRevision = 0) => ({
    operationId: randomUUID(),
    expectedRevision,
  });
  beforeAll(async () => {
    h = await createEnforcedIntegrationModule([
      SharedExpensesModule,
      BuiltInReportsModule,
      TransactionsModule,
    ]);
    jest
      .spyOn(h.module.get(ExchangeRateService), "getRateForDate")
      .mockResolvedValue(null);
    await h.owner.query(
      "INSERT INTO currencies (code,name,symbol,decimal_places) VALUES ('USD','US dollar','$',2) ON CONFLICT (code) DO NOTHING",
    );
    groups = h.module.get(SharedGroupsService);
    entries = h.module.get(SharedEntriesService);
    finance = h.module.get(SharedFinanceService);
    combined = h.module.get(SharedEntryFinanceService);
  });
  afterAll(async () => {
    if (h) await h.close();
  });
  beforeEach(async () => {
    await cleanTables(h.owner, ["shared_groups", "users"]);
    user = (await createTestUserDirect(h.owner)).id;
    groupId = (
      await asOwner(() =>
        groups.create(user, {
          ...command(),
          name: "Weekend",
          myName: "Me",
          currencyCode: "USD",
          participants: [{ name: "Anna" }, { name: "Ben" }],
        }),
      )
    ).id;
    const group = await asOwner(() => groups.detail(user, groupId));
    accountId = (
      await createTestAccount(h.owner, user, {
        openingBalance: 1000,
        currentBalance: 700,
        currencyCode: "USD",
      })
    ).id;
    categoryId = (await createTestCategory(h.owner, user, { name: "Dinner" }))
      .id;
    bankIds = [randomUUID(), randomUUID()];
    for (const [i, amount] of ["-200", "-100"].entries()) {
      await h.owner.query(
        "INSERT INTO transactions(id,user_id,account_id,transaction_date,amount,currency_code,category_id,external_id) VALUES ($1,$2,$3,'2026-01-10',$4,'USD',$5,$6)",
        [bankIds[i], user, accountId, amount, categoryId, `import:${i}`],
      );
    }
    settlementId = (
      await asOwner(() =>
        finance.enable(user, groupId, {
          ...command(group.revision),
          accountName: "Weekend",
        }),
      )
    ).accountId;
    dto = {
      ...command(group.revision),
      entry: {
        ...command(),
        type: "EXPENSE",
        title: "Dinner",
        date: "2026-01-10",
        amount: "300",
        currencyCode: "USD",
        splitMode: "EQUAL",
        shares: group.participants.map((p) => ({ participantId: p.id })),
        contributions: [
          { participantId: group.myParticipantId!, value: "300" },
        ],
      },
      finance: {
        ...command(1),
        categoryId,
        payments: [
          { bankTransactionId: bankIds[0], contributionAmount: "200" },
          { bankTransactionId: bankIds[1], contributionAmount: "100" },
        ],
      },
    };
  });
  async function balances() {
    return h.owner.query(
      "SELECT id, current_balance FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[accountId, settlementId]],
    );
  }
  async function counts() {
    const [row] = await h.owner.query(
      "SELECT (SELECT count(*)::int FROM shared_entries WHERE group_id=$1) AS entries, (SELECT count(*)::int FROM shared_postings WHERE group_id=$1) AS postings, (SELECT count(*)::int FROM transactions WHERE user_id=$2) AS transactions",
      [groupId, user],
    );
    return row;
  }
  it("previews without financial writes; commits two original bank IDs, one cost and a 200 claim; retry and unlink preserve the import", async () => {
    const before = await balances();
    const preview = await asOwner(() => combined.preview(user, groupId, dto));
    expect(preview.finance.payments.map((p) => p.cash)).toEqual([
      "-200.0000",
      "-100.0000",
    ]);
    expect(await counts()).toEqual({
      entries: 0,
      postings: 0,
      transactions: 2,
    });
    expect(await balances()).toEqual(before);
    const accepted = { ...dto, previewFingerprint: preview.fingerprint };
    const result = await asOwner(() => combined.save(user, groupId, accepted));
    expect(await asOwner(() => combined.save(user, groupId, accepted))).toEqual(
      result,
    );
    expect(await counts()).toEqual({
      entries: 1,
      postings: 1,
      transactions: 5,
    });
    expect(await balances()).toEqual(
      expect.arrayContaining([
        { id: accountId, current_balance: "700.0000" },
        { id: settlementId, current_balance: "200.0000" },
      ]),
    );
    const costs = await h.owner.query(
      "SELECT amount FROM transactions WHERE account_id=$1 AND NOT is_transfer",
      [settlementId],
    );
    expect(costs).toEqual([{ amount: "-100.0000" }]);
    await asOwner(() =>
      finance.unlink(user, groupId, result.entry.id, command(1)),
    );
    expect(await counts()).toEqual({
      entries: 1,
      postings: 0,
      transactions: 2,
    });
    const originals = await h.owner.query(
      "SELECT external_id, category_id, shared_expense_posting_id, is_transfer FROM transactions WHERE id=ANY($1::uuid[]) ORDER BY external_id",
      [bankIds],
    );
    expect(originals).toEqual(
      [0, 1].map((i) => ({
        external_id: `import:${i}`,
        category_id: categoryId,
        shared_expense_posting_id: null,
        is_transfer: false,
      })),
    );
    expect(await balances()).toEqual(before);
  });
  it("keeps later group-only expenses optional after the owner has accepted another entry", async () => {
    const review = h.module.get(SharedReviewService);
    const preview = await asOwner(() => combined.preview(user, groupId, dto));
    await asOwner(() =>
      combined.save(user, groupId, {
        ...dto,
        previewFingerprint: preview.fingerprint,
      }),
    );
    const before = await balances();
    const optional = await asOwner(() =>
      entries.save(user, groupId, {
        ...dto.entry,
        ...command(0),
        title: "Kept only in the group",
      }),
    );
    expect(await asOwner(() => finance.overview(user, groupId))).toMatchObject({
      pendingCount: 0,
      entries: expect.arrayContaining([
        expect.objectContaining({
          entryId: optional.id,
          posting: null,
          reviewReason: "NOT_BOOKED",
          needsReview: false,
        }),
      ]),
    });
    expect(await asOwner(() => review.summary(user))).toMatchObject({
      pendingCount: 0,
      unavailableGroupCount: 0,
    });
    expect(await balances()).toEqual(before);
  });
  it("discloses pending personal changes without moving booked balances, and isolates the review to its owner", async () => {
    const review = h.module.get(SharedReviewService);
    const preview = await asOwner(() => combined.preview(user, groupId, dto));
    const saved = await asOwner(() =>
      combined.save(user, groupId, {
        ...dto,
        previewFingerprint: preview.fingerprint,
      }),
    );
    expect(await asOwner(() => review.summary(user))).toMatchObject({
      pendingCount: 0,
      unavailableGroupCount: 0,
    });
    const before = await balances();
    await asOwner(() =>
      entries.save(
        user,
        groupId,
        {
          ...dto.entry,
          ...command(saved.entry.revision),
          title: "Updated description",
        },
        saved.entry.id,
      ),
    );
    expect(await asOwner(() => review.summary(user))).toMatchObject({
      pendingCount: 0,
    });
    const current = await asOwner(() =>
      entries.get(user, groupId, saved.entry.id),
    );
    const group = await asOwner(() => groups.detail(user, groupId));
    await asOwner(() =>
      entries.save(
        user,
        groupId,
        {
          ...dto.entry,
          ...command(current.revision),
          splitMode: "EXACT",
          shares: group.participants.map((p) => ({
            participantId: p.id,
            value: p.id === group.myParticipantId ? "80" : "110",
          })),
        },
        saved.entry.id,
      ),
    );
    const pending = await asOwner(() => review.summary(user));
    expect(pending).toMatchObject({
      pendingCount: 1,
      unavailableGroupCount: 0,
      groups: [{ groupId, accountId: settlementId, pendingCount: 1 }],
    });
    expect(await asOwner(() => finance.overview(user, groupId))).toMatchObject({
      pendingCount: 1,
      entries: [{ needsReview: true, reviewReason: "CHANGED" }],
    });
    expect(await balances()).toEqual(before);
    const stranger = (await createTestUserDirect(h.owner)).id;
    expect(
      await withUserContext(stranger, () => review.summary(stranger)),
    ).toMatchObject({ pendingCount: 0, groups: [] });
  });

  it("keeps accepted shared categories and transfer legs even when an active rule would replace the category", async () => {
    const ruleCategory = await createTestCategory(h.owner, user, {
      name: "Rule category",
    });
    await asOwner(() =>
      h.module.get(TransactionRulesService).create(user, {
        name: "Replace dinner category",
        triggers: ["create"],
        condition: { field: "description", op: "contains", value: "Dinner" },
        actions: [
          {
            type: "set_category",
            categoryId: ruleCategory.id,
            onlyIfEmpty: false,
          },
        ],
      }),
    );
    // Positive control: the enabled rule really changes an ordinary new row.
    const ordinary = await asOwner(() =>
      h.module.get(TransactionsService).create(user, {
        accountId,
        transactionDate: "2026-01-10",
        amount: -1,
        currencyCode: "USD",
        description: "Dinner",
        categoryId,
      }),
    );
    expect(ordinary.categoryId).toBe(ruleCategory.id);
    const input = {
      ...dto,
      finance: {
        ...dto.finance,
        payments: [
          {
            bankAccountId: accountId,
            bankAmount: "300",
            contributionAmount: "300",
          },
        ],
      },
    };
    const preview = await asOwner(() => combined.preview(user, groupId, input));
    const saved = await asOwner(() =>
      combined.save(user, groupId, {
        ...input,
        previewFingerprint: preview.fingerprint,
      }),
    );
    const rows = await h.owner.query(
      "SELECT account_id, amount, category_id, is_transfer FROM transactions WHERE shared_expense_posting_id=$1",
      [saved.postingId],
    );
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(
      expect.arrayContaining([
        {
          account_id: accountId,
          amount: "-300.0000",
          category_id: null,
          is_transfer: true,
        },
        {
          account_id: settlementId,
          amount: "300.0000",
          category_id: null,
          is_transfer: true,
        },
        {
          account_id: settlementId,
          amount: "-100.0000",
          category_id: categoryId,
          is_transfer: false,
        },
      ]),
    );
    expect(await balances()).toEqual(
      expect.arrayContaining([
        { id: accountId, current_balance: "399.0000" },
        { id: settlementId, current_balance: "200.0000" },
      ]),
    );
  });

  it("rejects a changed second bank source before publishing the entry or mutating either payment", async () => {
    const preview = await asOwner(() => combined.preview(user, groupId, dto));
    await h.owner.query(
      "UPDATE transactions SET description='A changed bank row' WHERE id=$1",
      [bankIds[1]],
    );
    const before = await balances();
    await expect(
      asOwner(() =>
        combined.save(user, groupId, {
          ...dto,
          previewFingerprint: preview.fingerprint,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await counts()).toEqual({
      entries: 0,
      postings: 0,
      transactions: 2,
    });
    expect(await balances()).toEqual(before);
  });
  it("rejects a stale group revision without a partial entry or personal posting", async () => {
    const preview = await asOwner(() => combined.preview(user, groupId, dto));
    await asOwner(() =>
      entries.save(user, groupId, {
        ...dto.entry,
        ...command(),
        title: "Another expense",
      }),
    );
    await expect(
      asOwner(() =>
        combined.save(user, groupId, {
          ...dto,
          previewFingerprint: preview.fingerprint,
        }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await counts()).toEqual({
      entries: 1,
      postings: 0,
      transactions: 2,
    });
  });
  it("serializes a repeated combined command without creating a second entry or cost", async () => {
    const preview = await asOwner(() => combined.preview(user, groupId, dto));
    const accepted = { ...dto, previewFingerprint: preview.fingerprint };
    const results = await Promise.all([
      asOwner(() => combined.save(user, groupId, accepted)),
      asOwner(() => combined.save(user, groupId, accepted)),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(await counts()).toEqual({
      entries: 1,
      postings: 1,
      transactions: 5,
    });
  });
  it("deletes only an empty group without personal integration and refuses stale deletion", async () => {
    const fresh = await asOwner(() =>
      groups.create(user, {
        ...command(),
        name: "Unused",
        myName: "Me",
        currencyCode: "USD",
        participants: [],
      }),
    );
    const detail = await asOwner(() => groups.detail(user, fresh.id));
    await expect(
      asOwner(() =>
        groups.removeEmpty(user, fresh.id, command(detail.revision + 1)),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await asOwner(() =>
      groups.removeEmpty(user, fresh.id, command(detail.revision)),
    );
    await expect(
      asOwner(() => groups.detail(user, fresh.id)),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      asOwner(() =>
        groups.removeEmpty(user, groupId, command(dto.expectedRevision)),
      ),
    ).rejects.toThrow();
  });
  it("reports only my consumption in spending, income and budget actuals, while a repayment moves cash and the claim once", async () => {
    await h.owner.query(
      "INSERT INTO user_preferences(user_id, default_currency) VALUES ($1,'USD') ON CONFLICT (user_id) DO UPDATE SET default_currency='USD'",
      [user],
    );
    const preview = await asOwner(() => combined.preview(user, groupId, dto));
    await asOwner(() =>
      combined.save(user, groupId, {
        ...dto,
        previewFingerprint: preview.fingerprint,
      }),
    );
    const group = await asOwner(() => groups.detail(user, groupId));
    const repayment = await asOwner(() =>
      entries.save(user, groupId, {
        ...command(),
        type: "REPAYMENT",
        title: "Anna paid back",
        amount: "100",
        currencyCode: "USD",
        date: "2026-01-15",
        splitMode: "EQUAL",
        contributions: [],
        shares: [],
        fromParticipantId: group.participants.find((p) => p.name === "Anna")!
          .id,
        toParticipantId: group.myParticipantId!,
        expectedGroupRevision: group.financialRevision,
      }),
    );
    const payment = {
      ...command(repayment.revision),
      bankAccountId: accountId,
      bankAmount: "100",
    };
    const review = await asOwner(() =>
      finance.preview(user, groupId, repayment.id, payment),
    );
    await asOwner(() =>
      finance.book(user, groupId, repayment.id, {
        ...payment,
        previewFingerprint: review.fingerprint,
      }),
    );
    const spending = await asOwner(() =>
      h.module
        .get(SpendingReportsService)
        .getSpendingByCategory(user, "2026-01-01", "2026-01-31"),
    );
    expect(spending.totalSpending).toBe(100);
    expect(spending.data).toEqual([
      expect.objectContaining({ categoryId, total: 100 }),
    ]);
    const income = await asOwner(() =>
      h.module
        .get(IncomeReportsService)
        .getIncomeVsExpenses(user, "2026-01-01", "2026-01-31"),
    );
    expect(income.totals).toMatchObject({
      income: 0,
      expenses: 100,
      net: -100,
    });
    expect(await balances()).toEqual(
      expect.arrayContaining([
        { id: accountId, current_balance: "800.0000" },
        { id: settlementId, current_balance: "100.0000" },
      ]),
    );
    const actuals = await asOwner(() =>
      withScopedDb(h.app, async (manager) => {
        const budgetId = randomUUID();
        await manager.query(
          "INSERT INTO budgets(id,user_id,name,period_start,currency_code) VALUES ($1,$2,'Monthly','2026-01-01','USD')",
          [budgetId, user],
        );
        const lines = manager.getRepository(BudgetCategory);
        const line = await lines.save(
          lines.create({
            budgetId,
            categoryId,
            amount: 500,
            isIncome: false,
            isTransfer: false,
          }),
        );
        const spending = await queryCategorySpending(
          manager.getRepository(Transaction),
          manager.getRepository(TransactionSplit),
          user,
          [line],
          "2026-01-01",
          "2026-01-31",
        );
        return {
          spending,
          displayed: resolveCategorySpentOrNull(line, spending),
        };
      }),
    );
    // The shared query returns signed ledger sums; the budget resolver presents spending.
    expect(actuals.spending.spendingMap.get(categoryId)).toBe(-100);
    expect(actuals.displayed).toBe(100);
    expect(actuals.spending.incompleteCategoryIds.size).toBe(0);
  });
  async function categorySplitSource() {
    const privateCategory = (
      await createTestCategory(h.owner, user, { name: "Private groceries" })
    ).id;
    const splitIds = [randomUUID(), randomUUID()];
    const tagId = randomUUID();
    await h.owner.query(
      "INSERT INTO tags(id,user_id,name) VALUES ($1,$2,'Receipt checked')",
      [tagId, user],
    );
    await h.owner.query(
      "UPDATE transactions SET is_split=true, category_id=NULL WHERE id=$1",
      [bankIds[0]],
    );
    for (const [i, amount] of ["-160", "-40"].entries()) {
      await h.owner.query(
        "INSERT INTO transaction_splits(id,transaction_id,kind,amount,category_id,memo) VALUES ($1,$2,'category',$3,$4,$5)",
        [
          splitIds[i],
          bankIds[0],
          amount,
          i === 0 ? categoryId : privateCategory,
          `Private note ${i}`,
        ],
      );
      await h.owner.query(
        "INSERT INTO transaction_split_tags(transaction_split_id,tag_id) VALUES ($1,$2)",
        [splitIds[i], tagId],
      );
    }
    dto = {
      ...dto,
      entry: {
        ...dto.entry,
        amount: "240",
        contributions: [{ ...dto.entry.contributions![0], value: "240" }],
      },
      finance: {
        ...dto.finance,
        payments: [
          {
            bankTransactionId: bankIds[0],
            contributionAmount: "140",
            sourceSplits: [{ splitId: splitIds[0], amount: "140" }],
          },
          { bankTransactionId: bankIds[1], contributionAmount: "100" },
        ],
      },
    };
    return { splitIds, tagId, privateCategory };
  }
  async function splitRows() {
    return h.owner.query(
      `SELECT s.*, ARRAY(SELECT tag_id FROM transaction_split_tags t WHERE t.transaction_split_id=s.id ORDER BY tag_id) AS tags
      FROM transaction_splits s WHERE s.transaction_id=$1 ORDER BY s.id`,
      [bankIds[0]],
    );
  }
  it("shares selected category portions, keeps private metadata and restores the exact original splits on unlink", async () => {
    const { splitIds, tagId, privateCategory } = await categorySplitSource();
    const original = await splitRows();
    const preview = await asOwner(() => combined.preview(user, groupId, dto));
    expect(preview.finance.payments[0].breakdown).toMatchObject({
      privateRemainder: "-60.0000",
      sharedPortion: "-140.0000",
    });
    expect(await splitRows()).toEqual(original);
    const saved = await asOwner(() =>
      combined.save(user, groupId, {
        ...dto,
        previewFingerprint: preview.fingerprint,
      }),
    );
    const after = await splitRows();
    expect(after).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: splitIds[0],
          amount: "-20.0000",
          category_id: categoryId,
          memo: "Private note 0",
          tags: [tagId],
        }),
        expect.objectContaining({
          id: splitIds[1],
          amount: "-40.0000",
          category_id: privateCategory,
          memo: "Private note 1",
          tags: [tagId],
        }),
      ]),
    );
    expect(after).toHaveLength(3);
    expect(await balances()).toEqual(
      expect.arrayContaining([
        { id: accountId, current_balance: "700.0000" },
        { id: settlementId, current_balance: "160.0000" },
      ]),
    );
    const reopened = await asOwner(() => finance.overview(user, groupId));
    expect(
      reopened.entries[0].posting?.originalBanks?.find(
        (row) => row.id === bankIds[0],
      )?.splits,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: splitIds[0],
          amount: "-160.0000",
          tagIds: [tagId],
        }),
      ]),
    );
    const input = { ...dto.finance, ...command(1) };
    const review = await asOwner(() =>
      finance.preview(user, groupId, saved.entry.id, input),
    );
    await asOwner(() =>
      finance.book(user, groupId, saved.entry.id, {
        ...input,
        previewFingerprint: review.fingerprint,
      }),
    );
    expect(await splitRows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: splitIds[0],
          amount: "-20.0000",
          tags: [tagId],
        }),
      ]),
    );
    await asOwner(() =>
      finance.unlink(user, groupId, saved.entry.id, command(1)),
    );
    expect(await splitRows()).toEqual(original);
    expect(
      (
        await h.owner.query(
          "SELECT is_split,external_id,amount FROM transactions WHERE id=$1",
          [bankIds[0]],
        )
      )[0],
    ).toEqual({ is_split: true, external_id: "import:0", amount: "-200.0000" });
    expect(await balances()).toEqual(
      expect.arrayContaining([
        { id: accountId, current_balance: "700.0000" },
        { id: settlementId, current_balance: "0.0000" },
      ]),
    );
  });
  it("rejects a changed category allocation after preview without publishing an entry or private posting", async () => {
    const { splitIds } = await categorySplitSource();
    const preview = await asOwner(() => combined.preview(user, groupId, dto));
    await h.owner.query(
      "UPDATE transaction_splits SET amount = CASE WHEN id=$1 THEN -159 ELSE -41 END WHERE id=ANY($2::uuid[])",
      [splitIds[0], splitIds],
    );
    const changed = await splitRows();
    await expect(
      asOwner(() =>
        combined.save(user, groupId, {
          ...dto,
          previewFingerprint: preview.fingerprint,
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await splitRows()).toEqual(changed);
    expect(await counts()).toEqual({
      entries: 0,
      postings: 0,
      transactions: 2,
    });
    expect(await balances()).toEqual(
      expect.arrayContaining([
        { id: accountId, current_balance: "700.0000" },
        { id: settlementId, current_balance: "0.0000" },
      ]),
    );
  });
  it("replaces a bridge-created payment with its imported source after review without a second lasting debit", async () => {
    dto = {
      ...dto,
      finance: {
        ...dto.finance,
        payments: [
          {
            bankAccountId: accountId,
            bankAmount: "200",
            contributionAmount: "200",
          },
          { bankTransactionId: bankIds[1], contributionAmount: "100" },
        ],
      },
    };
    const preview = await asOwner(() => combined.preview(user, groupId, dto));
    const saved = await asOwner(() =>
      combined.save(user, groupId, {
        ...dto,
        previewFingerprint: preview.fingerprint,
      }),
    );
    const [manual] = await h.owner.query(
      "SELECT transaction_id FROM shared_ledger_links WHERE posting_id=$1 AND kind='BANK' AND created_by_bridge",
      [saved.postingId],
    );
    const input = {
      ...command(1),
      categoryId,
      payments: [
        { bankTransactionId: bankIds[0], contributionAmount: "200" },
        { bankTransactionId: bankIds[1], contributionAmount: "100" },
      ],
    };
    const review = await asOwner(() =>
      finance.preview(user, groupId, saved.entry.id, input),
    );
    await asOwner(() =>
      finance.book(user, groupId, saved.entry.id, {
        ...input,
        previewFingerprint: review.fingerprint,
      }),
    );
    expect(
      await h.owner.query("SELECT id FROM transactions WHERE id=$1", [
        manual.transaction_id,
      ]),
    ).toHaveLength(0);
    expect(await balances()).toEqual(
      expect.arrayContaining([
        { id: accountId, current_balance: "700.0000" },
        { id: settlementId, current_balance: "200.0000" },
      ]),
    );
    expect(
      (
        await h.owner.query(
          "SELECT id FROM transactions WHERE account_id=$1 ORDER BY id",
          [accountId],
        )
      ).map((row: { id: string }) => row.id),
    ).toEqual([...bankIds].sort());
  });
});
