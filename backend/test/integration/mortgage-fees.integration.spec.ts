import { TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { AccountsModule } from "@/accounts/accounts.module";
import { Account, AccountType } from "@/accounts/entities/account.entity";
import { withUserContext } from "@/common/db/with-context";
import { LoanFeesModule } from "@/loan-fees/loan-fees.module";
import { LoanFeesService } from "@/loan-fees/loan-fees.service";
import type { LoanFeeDto } from "@/loan-fees/dto/loan-fee.dto";
import type { OccurrencePin } from "@/scheduled-transactions/occurrence-pin";
import { PostScheduledTransactionDto } from "@/scheduled-transactions/dto/post-scheduled-transaction.dto";
import { ScheduledTransaction } from "@/scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "@/scheduled-transactions/entities/scheduled-transaction-split.entity";
import { ScheduledTransactionsModule } from "@/scheduled-transactions/scheduled-transactions.module";
import { ScheduledTransactionsService } from "@/scheduled-transactions/scheduled-transactions.service";
import { TransactionsModule } from "@/transactions/transactions.module";
import {
  createIntegrationModule,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";
import {
  createTestAccount,
  createTestCategory,
} from "../helpers/test-factories";

/**
 * Mortgage fees against PostgreSQL (docs/specs/mortgage-fees.md,
 * INV-LOAN-011). A 100,000.00 annuity mortgage at 6 % paid monthly, a bill of
 * 1,000.00 = 500.00 principal + 500.00 interest. Two fees are added through
 * `LoanFeesService.replace`: a property tax of 3,600 a year (300.00 a
 * payment) and a default insurance of 0.6 % a year of the current balance
 * (100,000 x 0.6 % / 12 = 50.00). The occurrence then posts through
 * `ScheduledTransactionsService.post`, and the post-commit advancement prices
 * the next bill on the debt the posting left (99,500.00): 497.50 interest,
 * 502.50 principal and 49.75 insurance.
 */
describe("Mortgage fees (integration)", () => {
  let module: TestingModule;
  let service: ScheduledTransactionsService;
  let fees: LoanFeesService;
  let dataSource: DataSource;
  let userId: string;
  let chequingId: string;
  let mortgageId: string;
  let interestCategoryId: string;
  let taxCategoryId: string;
  let insuranceCategoryId: string;
  let scheduledId: string;

  const FIRST = "2026-08-01";
  const SECOND = "2026-09-01";

  const tax = (): LoanFeeDto => ({
    categoryId: taxCategoryId,
    name: "Property tax",
    calculation: "FIXED",
    basis: "ANNUAL",
    amount: 3600,
  });
  const insurance = (): LoanFeeDto => ({
    categoryId: insuranceCategoryId,
    name: "Default insurance",
    calculation: "PERCENT_CURRENT_BALANCE",
    basis: "ANNUAL",
    rate: 0.6,
  });

  const replace = (dtos: LoanFeeDto[]) =>
    withUserContext(userId, () => fees.replace(userId, mortgageId, dtos));

  const postPinned = (
    dto: Partial<PostScheduledTransactionDto>,
    pin: OccurrencePin,
  ) =>
    withUserContext(userId, () =>
      (
        service.post.bind(service) as (
          userId: string,
          id: string,
          dto: PostScheduledTransactionDto,
          options: { occurrencePin: OccurrencePin },
        ) => Promise<ScheduledTransaction | null>
      )(userId, scheduledId, dto as PostScheduledTransactionDto, {
        occurrencePin: pin,
      }),
    );

  beforeAll(async () => {
    module = await createIntegrationModule([
      AccountsModule,
      TransactionsModule,
      ScheduledTransactionsModule,
      LoanFeesModule,
    ]);
    service = module.get(ScheduledTransactionsService);
    fees = module.get(LoanFeesService);
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanTables(dataSource, [
      "action_history",
      "loan_fees",
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
       VALUES ('CAD', 'Canadian Dollar', '$', 2)
       ON CONFLICT DO NOTHING`,
    );
    userId = (await createTestUserDirect(dataSource)).id;
    chequingId = (
      await createTestAccount(dataSource, userId, {
        name: "Chequing",
        currencyCode: "CAD",
        openingBalance: 50000,
        currentBalance: 50000,
      })
    ).id;
    interestCategoryId = (
      await createTestCategory(dataSource, userId, {
        name: "Mortgage Interest",
      })
    ).id;
    taxCategoryId = (
      await createTestCategory(dataSource, userId, { name: "Property Tax" })
    ).id;
    insuranceCategoryId = (
      await createTestCategory(dataSource, userId, {
        name: "Mortgage Insurance",
      })
    ).id;

    mortgageId = (
      await createTestAccount(dataSource, userId, {
        name: "Mortgage",
        currencyCode: "CAD",
        openingBalance: -100000,
        currentBalance: -100000,
      })
    ).id;
    const scheduled = await dataSource.manager.save(
      dataSource.manager.create(ScheduledTransaction, {
        userId,
        accountId: chequingId,
        name: "Mortgage Payment",
        amount: -1000,
        currencyCode: "CAD",
        frequency: "MONTHLY",
        nextDueDate: FIRST,
        startDate: FIRST,
        isActive: true,
        isSplit: true,
      } as Partial<ScheduledTransaction>),
    );
    scheduledId = scheduled.id;
    await dataSource.manager.save([
      dataSource.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduledId,
        kind: "transfer",
        transferAccountId: mortgageId,
        amount: -500,
        memo: "Principal",
      } as Partial<ScheduledTransactionSplit>),
      dataSource.manager.create(ScheduledTransactionSplit, {
        scheduledTransactionId: scheduledId,
        kind: "category",
        categoryId: interestCategoryId,
        amount: -500,
        memo: "Interest",
      } as Partial<ScheduledTransactionSplit>),
    ]);
    await dataSource.manager.update(Account, mortgageId, {
      accountType: AccountType.MORTGAGE,
      mortgageType: "ANNUITY",
      interestRate: 6,
      paymentFrequency: "MONTHLY",
      paymentAmount: 1000,
      paymentStartDate: new Date(`${FIRST}T00:00:00`),
      amortizationMonths: 300,
      originalPrincipal: 100000,
      interestCategoryId,
      sourceAccountId: chequingId,
      scheduledTransactionId: scheduledId,
    } as Partial<Account>);
  });

  /** The template's parent and its lines, keyed by category or "principal". */
  async function template() {
    const [parent]: { amount: string; next_due_date: string }[] =
      await dataSource.query(
        `SELECT amount, TO_CHAR(next_due_date, 'YYYY-MM-DD') AS next_due_date
           FROM scheduled_transactions WHERE id = $1`,
        [scheduledId],
      );
    const lines: {
      amount: string;
      category_id: string | null;
      transfer_account_id: string | null;
      memo: string | null;
    }[] = await dataSource.query(
      `SELECT amount, category_id, transfer_account_id, memo
         FROM scheduled_transaction_splits WHERE scheduled_transaction_id = $1`,
      [scheduledId],
    );
    const byKey: Record<string, number> = {};
    for (const line of lines) {
      byKey[
        line.transfer_account_id ? "principal" : (line.category_id as string)
      ] = Number(line.amount);
    }
    return {
      parent: Number(parent.amount),
      nextDueDate: parent.next_due_date,
      lines: byKey,
      count: lines.length,
      memos: lines.map((l) => l.memo).sort(),
    };
  }

  async function posted(date: string) {
    const [parent]: { id: string; amount: string }[] = await dataSource.query(
      `SELECT id, amount FROM transactions
        WHERE account_id = $1 AND transaction_date = $2 AND parent_transaction_id IS NULL`,
      [chequingId, date],
    );
    const lines: {
      amount: string;
      category_id: string | null;
      transfer_account_id: string | null;
    }[] = await dataSource.query(
      `SELECT s.amount, s.category_id, t.account_id AS transfer_account_id
         FROM transaction_splits s
         LEFT JOIN transactions t ON t.id = s.linked_transaction_id
        WHERE s.transaction_id = $1`,
      [parent.id],
    );
    const byKey: Record<string, number> = {};
    for (const line of lines) {
      byKey[
        line.transfer_account_id ? "principal" : (line.category_id as string)
      ] = Number(line.amount);
    }
    return { parent: Number(parent.amount), lines: byKey };
  }

  async function mortgageBalance(): Promise<number> {
    const [{ current_balance: balance }]: { current_balance: string }[] =
      await dataSource.query(
        `SELECT current_balance FROM accounts WHERE id = $1`,
        [mortgageId],
      );
    return Number(balance);
  }

  it("adds a line per fee priced at the next due date, and moves the parent by their sum", async () => {
    const saved = await replace([tax(), insurance()]);

    expect(saved.map((f) => [f.categoryId, f.sortOrder])).toEqual([
      [taxCategoryId, 0],
      [insuranceCategoryId, 1],
    ]);
    expect(await template()).toMatchObject({
      parent: -1350,
      count: 4,
      lines: {
        principal: -500,
        [interestCategoryId]: -500,
        [taxCategoryId]: -300,
        [insuranceCategoryId]: -50,
      },
      memos: ["Default insurance", "Interest", "Principal", "Property tax"],
    });
  });

  it("posts the bill with its fee lines and prices the next one's balance fee on the lower debt", async () => {
    await replace([tax(), insurance()]);

    await postPinned(
      { transactionDate: FIRST },
      { occurrenceDate: FIRST, overrideId: null },
    );

    expect(await posted(FIRST)).toEqual({
      parent: -1350,
      lines: {
        principal: -500,
        [interestCategoryId]: -500,
        [taxCategoryId]: -300,
        [insuranceCategoryId]: -50,
      },
    });
    // Only the principal reduces the debt; the fees are expenses.
    expect(await mortgageBalance()).toBe(-99500);
    // 99,500 x 6 % / 12 = 497.50 interest, 502.50 principal; 99,500 x 0.6 %
    // / 12 = 49.75 insurance; the fixed tax stands.
    expect(await template()).toMatchObject({
      nextDueDate: SECOND,
      parent: -1349.75,
      lines: {
        principal: -502.5,
        [interestCategoryId]: -497.5,
        [taxCategoryId]: -300,
        [insuranceCategoryId]: -49.75,
      },
    });
  });

  it("removes a dropped fee's line and returns the parent to the loan's installment", async () => {
    await replace([tax(), insurance()]);
    await replace([tax()]);

    expect(await template()).toMatchObject({
      parent: -1300,
      count: 3,
      lines: { [taxCategoryId]: -300 },
    });
    const [{ c }]: { c: number }[] = await dataSource.query(
      `SELECT count(*)::int AS c FROM loan_fees WHERE account_id = $1`,
      [mortgageId],
    );
    expect(c).toBe(1);

    await replace([]);
    expect(await template()).toMatchObject({ parent: -1000, count: 2 });
  });

  it("refuses a fee on the interest category and writes nothing", async () => {
    await expect(
      replace([{ ...tax(), categoryId: interestCategoryId }]),
    ).rejects.toThrow();
    expect(await template()).toMatchObject({ parent: -1000, count: 2 });
    const [{ c }]: { c: number }[] = await dataSource.query(
      `SELECT count(*)::int AS c FROM loan_fees`,
    );
    expect(c).toBe(0);
  });

  it("holds one fee per category per mortgage in the database", async () => {
    await replace([tax()]);
    await expect(
      dataSource.query(
        `INSERT INTO loan_fees (user_id, account_id, category_id, name, calculation, basis, amount)
         VALUES ($1, $2, $3, 'Again', 'FIXED', 'PER_PAYMENT', 10)`,
        [userId, mortgageId, taxCategoryId],
      ),
    ).rejects.toThrow(/uq_loan_fees_account_category/);
  });
});
