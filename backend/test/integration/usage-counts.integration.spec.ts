import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { CategoriesModule } from "@/categories/categories.module";
import { CategoriesService } from "@/categories/categories.service";
import { findCategoryReferences } from "@/categories/category-references";
import { PayeesModule } from "@/payees/payees.module";
import { PayeesService } from "@/payees/payees.service";
import { findPayeeReferences } from "@/payees/payee-references";
import { TagsModule } from "@/tags/tags.module";
import { TagsService } from "@/tags/tags.service";
import { withUserContext } from "@/common/db/with-context";
import { withScopedDb } from "@/common/db/scoped-db";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
  createTestPayee,
} from "../helpers/test-factories";

// Audit #2365 (a), #2027: the usage count a list shows and the references a
// delete refuses for are one set. A record used only by a schedule or a budget
// line must not read 0 while its delete answers 409 "in use".
describe("usage counts agree with the delete guard (integration)", () => {
  let module: TestingModule;
  let db: DataSource;
  let categories: CategoriesService;
  let payees: PayeesService;
  let tags: TagsService;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([
      CategoriesModule,
      PayeesModule,
      TagsModule,
    ]);
    db = module.get(DataSource);
    categories = module.get(CategoriesService);
    payees = module.get(PayeesService);
    tags = module.get(TagsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "transaction_rules",
      "custom_reports",
      "budget_categories",
      "budgets",
      "scheduled_transaction_overrides",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transactions",
      "tags",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await db.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places) VALUES ('USD', 'US Dollar', '$', 2) ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(db)).id;
    accountId = (await createTestAccount(db, userId)).id;
  });

  const seedSchedule = async (opts: {
    categoryId?: string | null;
    payeeId?: string | null;
    tagIds?: string[];
  }): Promise<string> => {
    const [row] = await db.query(
      `INSERT INTO scheduled_transactions (user_id, account_id, name, amount,
         currency_code, frequency, next_due_date, start_date, category_id,
         payee_id, tag_ids)
       VALUES ($1, $2, 'Rent', -500, 'USD', 'MONTHLY', '2026-12-01',
               '2026-12-01', $3, $4, $5::jsonb)
       RETURNING id`,
      [
        userId,
        accountId,
        opts.categoryId ?? null,
        opts.payeeId ?? null,
        JSON.stringify(opts.tagIds ?? []),
      ],
    );
    return row.id;
  };

  const listedCategory = async (id: string) =>
    (
      await withUserContext(userId, () =>
        categories.findAll(userId, false, { withUsage: true }),
      )
    ).find((c) => c.id === id);
  const listedPayee = async (id: string) =>
    (
      await withUserContext(userId, () =>
        payees.findAll(userId, undefined, { withUsage: true }),
      )
    ).find((p) => p.id === id);
  const guardCount = async (
    find: typeof findCategoryReferences | typeof findPayeeReferences,
    id: string,
  ) =>
    withUserContext(userId, () =>
      withScopedDb(db, async (m) =>
        (await find(m, userId, id)).reduce((n, r) => n + r.count, 0),
      ),
    );

  it("counts a category used only by a schedule", async () => {
    const category = await createTestCategory(db, userId);
    await seedSchedule({ categoryId: category.id });

    expect((await listedCategory(category.id))?.usageCount).toBe(1);
    expect(await guardCount(findCategoryReferences, category.id)).toBe(1);
  });

  it("counts a category used only by a budget line", async () => {
    const category = await createTestCategory(db, userId);
    const [budget] = await db.query(
      `INSERT INTO budgets (user_id, name, period_start, currency_code)
       VALUES ($1, 'B', '2026-01-01', 'USD') RETURNING id`,
      [userId],
    );
    await db.query(
      `INSERT INTO budget_categories (budget_id, category_id, amount) VALUES ($1, $2, 100)`,
      [budget.id, category.id],
    );

    expect((await listedCategory(category.id))?.usageCount).toBe(1);
    expect(await guardCount(findCategoryReferences, category.id)).toBe(1);
  });

  it("counts a payee used only by a schedule", async () => {
    const payee = await createTestPayee(db, userId);
    await seedSchedule({ payeeId: payee.id });

    expect((await listedPayee(payee.id))?.usageCount).toBe(1);
    expect(await guardCount(findPayeeReferences, payee.id)).toBe(1);
  });

  it("counts a tag used only in scheduled_transactions.tag_ids", async () => {
    const [tag] = await db.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, 'T') RETURNING id`,
      [userId],
    );
    await seedSchedule({ tagIds: [tag.id] });

    const counts = await withUserContext(userId, () =>
      tags.getAllTransactionCounts(userId),
    );
    expect(counts[tag.id]).toBe(1);
  });

  it("counts a rule or report naming the record once, as the guard does", async () => {
    const category = await createTestCategory(db, userId);
    const payee = await createTestPayee(db, userId);
    const [tag] = await db.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, 'R') RETURNING id`,
      [userId],
    );
    const condition = JSON.stringify({ payeeId: payee.id, tagIds: [tag.id] });
    const actions = JSON.stringify([
      { categoryId: category.id, again: category.id, tagId: tag.id },
    ]);
    await db.query(
      `INSERT INTO transaction_rules (user_id, name, position, condition, actions)
       VALUES ($1, 'r', 1, $2::jsonb, $3::jsonb)`,
      [userId, condition, actions],
    );
    await db.query(
      `INSERT INTO custom_reports (user_id, name, filters)
       VALUES ($1, 'rep', $2::jsonb)`,
      [userId, JSON.stringify({ categoryIds: [category.id], tags: [tag.id] })],
    );

    // The rule counts once however many times it names the category.
    expect(await guardCount(findCategoryReferences, category.id)).toBe(2);
    expect((await listedCategory(category.id))?.usageCount).toBe(2);
    expect(await guardCount(findPayeeReferences, payee.id)).toBe(1);
    expect((await listedPayee(payee.id))?.usageCount).toBe(1);

    const counts = await withUserContext(userId, () =>
      tags.getAllTransactionCounts(userId),
    );
    expect(counts[tag.id]).toBe(2);
    const impact = await withUserContext(userId, () =>
      tags.getDeleteImpact(userId, tag.id),
    );
    expect(impact).toMatchObject({ rules: 1, customReports: 1 });
  });

  it("counts a schedule override naming the category", async () => {
    const category = await createTestCategory(db, userId);
    const scheduleId = await seedSchedule({});
    await db.query(
      `INSERT INTO scheduled_transaction_overrides (scheduled_transaction_id,
         original_date, override_date, category_id)
       VALUES ($1, '2027-01-01', '2027-01-01', $2)`,
      [scheduleId, category.id],
    );

    expect(await guardCount(findCategoryReferences, category.id)).toBe(1);
    expect((await listedCategory(category.id))?.usageCount).toBe(1);
  });

  it("leaves usageCount out of the plain lists", async () => {
    const category = await createTestCategory(db, userId);
    const plain = (
      await withUserContext(userId, () => categories.findAll(userId))
    ).find((c) => c.id === category.id);
    expect(plain).not.toHaveProperty("usageCount");
  });

  it("does not count another user's rule, report or schedule", async () => {
    const other = (await createTestUserDirect(db)).id;
    const [tag] = await db.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, 'Mine') RETURNING id`,
      [userId],
    );
    // The other user's rows name this user's tag id (RLS is off by default).
    await db.query(
      `INSERT INTO transaction_rules (user_id, name, position, condition, actions)
       VALUES ($1, 'x', 1, '{}'::jsonb, $2::jsonb)`,
      [other, JSON.stringify([{ tagId: tag.id }])],
    );
    await db.query(
      `INSERT INTO custom_reports (user_id, name, filters) VALUES ($1, 'x', $2::jsonb)`,
      [other, JSON.stringify({ tags: [tag.id] })],
    );

    const impact = await withUserContext(userId, () =>
      tags.getDeleteImpact(userId, tag.id),
    );
    expect(impact).toMatchObject({ rules: 0, customReports: 0 });
    const counts = await withUserContext(userId, () =>
      tags.getAllTransactionCounts(userId),
    );
    expect(counts[tag.id]).toBeUndefined();
  });

  it("splits a category's usage into what a reassign can move", async () => {
    const budgetOnly = await createTestCategory(db, userId);
    const [budget] = await db.query(
      `INSERT INTO budgets (user_id, name, period_start, currency_code)
       VALUES ($1, 'B', '2026-01-01', 'USD') RETURNING id`,
      [userId],
    );
    await db.query(
      `INSERT INTO budget_categories (budget_id, category_id, amount) VALUES ($1, $2, 100)`,
      [budget.id, budgetOnly.id],
    );
    const scheduled = await createTestCategory(db, userId);
    await seedSchedule({ categoryId: scheduled.id });

    expect(
      await withUserContext(userId, () =>
        categories.getUsage(userId, budgetOnly.id),
      ),
    ).toEqual({ count: 1, movableCount: 0 });
    expect(
      await withUserContext(userId, () =>
        categories.getUsage(userId, scheduled.id),
      ),
    ).toEqual({ count: 1, movableCount: 1 });
  });

  it("matches an upper-case id in a rule the same way in the list and the guard", async () => {
    const category = await createTestCategory(db, userId);
    const [tag] = await db.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, 'U') RETURNING id`,
      [userId],
    );
    await db.query(
      `INSERT INTO transaction_rules (user_id, name, position, condition, actions)
       VALUES ($1, 'r', 1, '{}'::jsonb, $2::jsonb)`,
      [
        userId,
        JSON.stringify([
          {
            categoryId: category.id.toUpperCase(),
            tagId: tag.id.toUpperCase(),
          },
        ]),
      ],
    );

    expect(await guardCount(findCategoryReferences, category.id)).toBe(1);
    expect((await listedCategory(category.id))?.usageCount).toBe(1);
    // The delete impact reads the id in either case, too.
    for (const id of [tag.id, tag.id.toUpperCase()]) {
      const impact = await withUserContext(userId, () =>
        tags.getDeleteImpact(userId, id),
      );
      expect(impact.rules).toBe(1);
    }
    const counts = await withUserContext(userId, () =>
      tags.getAllTransactionCounts(userId),
    );
    expect(counts[tag.id]).toBe(1);
  });
});
