import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";

import { TagsModule } from "@/tags/tags.module";
import { TagsService } from "@/tags/tags.service";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * scheduled_transactions.tag_ids is JSONB with no foreign key. Deleting a tag
 * must strip its id there, or posting the schedule fails with "One or more
 * tags not found" (manually and from the auto-post cron).
 */
describe("tag delete vs scheduled tag_ids (integration)", () => {
  let module: TestingModule;
  let db: DataSource;
  let tags: TagsService;
  let scheduled: ScheduledTransactionsService;
  let userId: string;
  let accountId: string;

  beforeAll(async () => {
    module = await createIntegrationModule([
      TagsModule,
      ScheduledTransactionsModule,
    ]);
    db = module.get(DataSource);
    tags = module.get(TagsService);
    scheduled = module.get(ScheduledTransactionsService);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(db, [
      "transaction_tags",
      "scheduled_transaction_overrides",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transactions",
      "tags",
      "accounts",
      "users",
    ]);
    userId = (await createTestUserDirect(db)).id;
    accountId = (await createTestAccount(db, userId)).id;
  });

  const seedTag = async (name: string): Promise<string> => {
    const [row] = await db.query(
      `INSERT INTO tags (user_id, name) VALUES ($1, $2) RETURNING id`,
      [userId, name],
    );
    return row.id;
  };

  const seedSchedule = async (tagIds: string[]): Promise<string> => {
    const [row] = await db.query(
      `INSERT INTO scheduled_transactions (user_id, account_id, name, amount,
         currency_code, frequency, next_due_date, start_date, tag_ids)
       VALUES ($1, $2, 'Rent', -500, 'USD', 'MONTHLY', '2026-12-01',
               '2026-12-01', $3::jsonb)
       RETURNING id`,
      [userId, accountId, JSON.stringify(tagIds)],
    );
    return row.id;
  };

  const tagIdsOf = async (id: string): Promise<string[]> =>
    (
      await db.query(
        `SELECT tag_ids FROM scheduled_transactions WHERE id = $1`,
        [id],
      )
    )[0].tag_ids;

  it("strips only the deleted id and the schedule still posts", async () => {
    const gone = await seedTag("Gone");
    const kept = await seedTag("Kept");
    const schedule = await seedSchedule([gone, kept]);
    const untouched = await seedSchedule([kept]);

    await withUserContext(userId, () => tags.remove(userId, gone));

    expect(await tagIdsOf(schedule)).toEqual([kept]);
    expect(await tagIdsOf(untouched)).toEqual([kept]);

    await withUserContext(userId, () => scheduled.post(userId, schedule));
    const posted = await db.query(
      `SELECT tt.tag_id FROM transaction_tags tt
         JOIN transactions t ON t.id = tt.transaction_id
        WHERE t.user_id = $1`,
      [userId],
    );
    expect(posted.map((r: { tag_id: string }) => r.tag_id)).toEqual([kept]);
  });

  it("counts every kind of place the tag is used", async () => {
    const tag = await seedTag("Everywhere");
    await seedSchedule([tag]);
    const [txn] = await db.query(
      `INSERT INTO transactions (user_id, account_id, transaction_date, amount, currency_code)
       VALUES ($1, $2, '2026-01-01', -1, 'USD') RETURNING id`,
      [userId, accountId],
    );
    await db.query(
      `INSERT INTO transaction_tags (transaction_id, tag_id) VALUES ($1, $2)`,
      [txn.id, tag],
    );
    const [split] = await db.query(
      `INSERT INTO transaction_splits (transaction_id, amount) VALUES ($1, -1) RETURNING id`,
      [txn.id],
    );
    await db.query(
      `INSERT INTO transaction_split_tags (transaction_split_id, tag_id) VALUES ($1, $2)`,
      [split.id, tag],
    );

    const impact = await withUserContext(userId, () =>
      tags.getDeleteImpact(userId, tag),
    );
    expect(impact).toEqual({
      transactions: 1,
      transactionSplits: 1,
      scheduledTransactions: 1,
      scheduledSplits: 0,
      securities: 0,
      rules: 0,
      customReports: 0,
    });
  });
});
