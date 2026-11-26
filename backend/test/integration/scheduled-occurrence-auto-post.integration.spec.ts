import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionOverride } from "@/scheduled-transactions/entities/scheduled-transaction-override.entity";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import { todayInTimezone } from "@/common/date-utils";
import { withUserContext } from "@/common/db/with-context";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import { createTestAccount } from "../helpers/test-factories";

/**
 * One occurrence's own auto-post choice (INV-OCCURRENCE-004): the override's
 * `auto_post` decides whether the real hourly cron posts that occurrence,
 * overriding the schedule's in both directions, and an estimated schedule's
 * occurrence auto-posts only when it opts in and states its amount. Drives
 * `processAutoPostTransactions()` against real PostgreSQL, so the cron's SQL
 * predicate (`OCCURRENCE_AUTO_POSTS_SQL`) is exercised, not mocked.
 */
describe("Per-occurrence auto-post (integration)", () => {
  const AMOUNT = -42.5;
  const STATED = -61.25;
  const OPENING = 1000;

  let module: TestingModule;
  let service: ScheduledTransactionsService;
  let dataSource: DataSource;
  let userId: string;
  let accountId: string;
  let due: string;

  beforeAll(async () => {
    module = await createIntegrationModule([
      AccountsModule,
      TransactionsModule,
      ScheduledTransactionsModule,
    ]);
    service = module.get(ScheduledTransactionsService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "scheduled_transaction_postings",
      "scheduled_transaction_overrides",
      "scheduled_transaction_splits",
      "scheduled_transactions",
      "transaction_splits",
      "transactions",
      "accounts",
      "categories",
      "payees",
      "monthly_account_balances",
      "users",
    ]);
    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places)
       VALUES ('USD', 'US Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    // No preference row: the cron buckets the user as UTC, and so does this.
    due = todayInTimezone("UTC")!;
    const user = await createTestUserDirect(dataSource);
    userId = user.id;
    const account = await createTestAccount(dataSource, userId, {
      name: "Chequing",
      openingBalance: OPENING,
      currentBalance: OPENING,
    });
    accountId = account.id;
  });

  async function schedule(
    fields: Partial<ScheduledTransaction>,
  ): Promise<string> {
    const row = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransaction, {
        userId,
        accountId,
        name: "Hydro",
        amount: AMOUNT,
        currencyCode: "USD",
        frequency: "MONTHLY",
        nextDueDate: due,
        startDate: "2020-01-01",
        isActive: true,
        autoPost: false,
        ...fields,
      } as Partial<ScheduledTransaction>),
    );
    return row.id;
  }

  /** Written directly, so a state the service refuses can be set up too. */
  async function override(
    scheduledTransactionId: string,
    fields: Partial<ScheduledTransactionOverride>,
  ): Promise<void> {
    await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransactionOverride, {
        scheduledTransactionId,
        originalDate: due,
        overrideDate: due,
        ...fields,
      }),
    );
  }

  async function postedAmounts(scheduledId: string): Promise<number[]> {
    const rows: { amount: string }[] = await dataSource.query(
      `SELECT t.amount
         FROM scheduled_transaction_postings p
         JOIN transactions t ON t.id = p.transaction_id
        WHERE p.scheduled_transaction_id = $1`,
      [scheduledId],
    );
    return rows.map((r) => Number(r.amount));
  }

  it("reports each next occurrence's own answer on the list and the occurrences read", async () => {
    const optedIn = await schedule({ name: "Hydro", autoPost: false });
    await override(optedIn, { autoPost: true });
    const optedOut = await schedule({ name: "Gym", autoPost: true });
    await override(optedOut, { autoPost: false });
    const plain = await schedule({ name: "Rent", autoPost: true });

    const list = await withUserContext(userId, () => service.findAll(userId));
    const byId = new Map(list.map((row) => [row.id, row]));
    expect(byId.get(optedIn)?.nextOccurrenceAutoPosts).toBe(true);
    expect(byId.get(optedOut)?.nextOccurrenceAutoPosts).toBe(false);
    expect(byId.get(plain)?.nextOccurrenceAutoPosts).toBe(true);

    const occurrences = await withUserContext(userId, () =>
      service.findEffectiveOccurrences(userId, {
        through: due,
        maxPerSchedule: 1,
      }),
    );
    const autoPosts = new Map(
      occurrences.map((o) => [o.scheduledTransactionId, o.autoPosts]),
    );
    expect(autoPosts.get(optedIn)).toBe(true);
    expect(autoPosts.get(optedOut)).toBe(false);
    expect(autoPosts.get(plain)).toBe(true);
  });

  it("posts an opted-in occurrence of a schedule that does not auto-post", async () => {
    const id = await schedule({ autoPost: false });
    await override(id, { autoPost: true });

    await service.processAutoPostTransactions();

    expect(await postedAmounts(id)).toEqual([AMOUNT]);
  });

  it("leaves a manual schedule's occurrence without a choice for a person", async () => {
    const id = await schedule({ autoPost: false });
    await override(id, { amount: STATED });

    await service.processAutoPostTransactions();

    expect(await postedAmounts(id)).toEqual([]);
  });

  it("leaves an opted-out occurrence of an auto-posting schedule for a person", async () => {
    const id = await schedule({ autoPost: true });
    await override(id, { autoPost: false, amount: STATED });

    await service.processAutoPostTransactions();

    expect(await postedAmounts(id)).toEqual([]);
  });

  it("posts an estimated schedule's opted-in occurrence at its stated amount", async () => {
    const id = await schedule({ amountIsEstimated: true });
    await override(id, { autoPost: true, amount: STATED });

    await service.processAutoPostTransactions();

    expect(await postedAmounts(id)).toEqual([STATED]);
  });

  it("does not post an estimated schedule's opted-in occurrence that still follows the estimate", async () => {
    const id = await schedule({ amountIsEstimated: true });
    await override(id, { autoPost: true, amount: null });

    await service.processAutoPostTransactions();

    expect(await postedAmounts(id)).toEqual([]);
  });
});
