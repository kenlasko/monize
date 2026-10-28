import { randomUUID } from "node:crypto";
import { TransactionsModule } from "@/transactions/transactions.module";
import { CategoriesModule } from "@/categories/categories.module";
import { TransactionsService } from "@/transactions/transactions.service";
import { CategoriesService } from "@/categories/categories.service";
import { PayeesService } from "@/payees/payees.service";
import { AccrualsService } from "@/accruals/accruals.service";
import { settlePendingHistoryWrites } from "@/action-history/action-history.service";
import { withUserContext } from "@/common/db/with-context";
import { createTestAccount } from "./test-factories";
import {
  createEnforcedIntegrationModule,
  createTestUserDirect,
  cleanTables,
} from "./integration-setup";

/** Actual services and enforced RLS; raw fixture writes never touch production. */
export async function createAccrualTaxonomyFixture(
  extraModules: Parameters<typeof createEnforcedIntegrationModule>[0] = [],
) {
  const h = await createEnforcedIntegrationModule([
    TransactionsModule,
    CategoriesModule,
    ...extraModules,
  ]);
  const transactions = h.module.get(TransactionsService),
    categories = h.module.get(CategoriesService),
    payees = h.module.get(PayeesService),
    accruals = new AccrualsService(h.app);
  let user: string,
    account: string,
    root: string,
    child: string,
    grandchild: string,
    income: string,
    other: string,
    payee: string;
  const as = <T>(fn: () => Promise<T>) => withUserContext(user, fn);
  async function reset() {
    await settlePendingHistoryWrites();
    await cleanTables(h.owner, [
      "transactions",
      "scheduled_transactions",
      "accounts",
      "categories",
      "payees",
      "users",
    ]);
    await h.owner.query(
      "INSERT INTO currencies(code,name,symbol,decimal_places) VALUES('USD','US Dollar','$',2) ON CONFLICT DO NOTHING",
    );
    user = (await createTestUserDirect(h.owner)).id;
    await h.owner.query(
      "INSERT INTO user_preferences(user_id,reporting_basis,accrual_enabled) VALUES($1,'accrual',true)",
      [user],
    );
    account = (
      await createTestAccount(h.owner, user, {
        name: "Taxonomy",
        openingBalance: 1000,
        currentBalance: 1000,
      })
    ).id;
    [root, child, grandchild, income, other] = Array.from({ length: 5 }, () =>
      randomUUID(),
    );
    await h.owner.query(
      `INSERT INTO categories(id,user_id,name,is_income,parent_id) VALUES
   ($1,$6,'Expense root',false,NULL),($2,$6,'Child',false,$1),($3,$6,'Grandchild',false,$2),
   ($4,$6,'Income',true,NULL),($5,$6,'Other expense',false,NULL)`,
      [root, child, grandchild, income, other, user],
    );
    payee = (await as(() => payees.create(user, { name: "Tax office" }))).id;
  }
  async function source(
    options: {
      categoryId?: string | null;
      splitCategories?: string[];
      payeeName?: string;
    } = {},
  ) {
    const categoryId =
      options.categoryId === undefined ? root : options.categoryId;
    const tx = await as(() =>
      transactions.create(user, {
        accountId: account,
        currencyCode: "USD",
        transactionDate: "2026-06-15",
        amount: -1200.0001,
        payeeId: payee,
        ...(options.payeeName !== undefined
          ? { payeeName: options.payeeName }
          : {}),
        ...(options.splitCategories
          ? {
              splits: options.splitCategories.map((categoryId, index) => ({
                amount: index === 0 ? -600 : -600.0001,
                categoryId,
                memo: String(index),
              })),
            }
          : categoryId
            ? { categoryId }
            : {}),
      }),
    );
    await settlePendingHistoryWrites();
    const lines: { id: string; categoryId: string }[] = await h.owner.query(
      'SELECT id,category_id AS "categoryId" FROM transaction_splits WHERE transaction_id=$1 ORDER BY memo,id',
      [tx.id],
    );
    return { tx, lines };
  }
  async function accrue(id: string, splitId?: string) {
    const input = {
      sourceTransactionId: id,
      sourceSplitId: splitId,
      preset: "NTM" as const,
      family: "expense" as const,
    };
    const p = await as(() => accruals.preview(user, input));
    await as(() =>
      accruals.save(user, {
        ...input,
        fingerprint: p.fingerprint,
        expectedScheduleId: p.expectedScheduleId,
        expectedRevision: p.expectedRevision,
      }),
    );
  }
  async function scheduled(categoryId = root) {
    const id = randomUUID(),
      lineId = randomUUID();
    await h.owner.query(
      `INSERT INTO scheduled_transactions
   (id,user_id,account_id,name,payee_id,category_id,amount,currency_code,next_due_date,start_date)
   VALUES($1,$2,$3,'Tax bill',$4,$5,-100,'USD','2026-06-15','2026-06-15')`,
      [id, user, account, payee, categoryId],
    );
    await h.owner.query(
      "INSERT INTO scheduled_transaction_splits(id,scheduled_transaction_id,category_id,amount) VALUES($1,$2,$3,-100)",
      [lineId, id, categoryId],
    );
    return { id, lineId };
  }
  const states = (id: string) =>
    h.owner.query(
      `SELECT s.id,s.revision,s.family,s.source_split_id AS "splitId",s.source_fingerprint AS fingerprint,
   (SELECT jsonb_agg(jsonb_build_array(a.recognition_date,a.amount::text) ORDER BY a.period_index)
    FROM accrual_allocations a WHERE a.schedule_id=s.id) AS allocations
   FROM accrual_schedules s WHERE s.source_transaction_id=$1 ORDER BY s.source_split_id NULLS FIRST,s.id`,
      [id],
    );
  const graph = () =>
    h.owner.query(
      'SELECT id,parent_id AS "parentId",name,is_income AS "isIncome" FROM categories WHERE user_id=$1 ORDER BY id',
      [user],
    );
  const bank = async () =>
    (
      await h.owner.query(
        "SELECT current_balance::text AS balance FROM accounts WHERE id=$1",
        [account],
      )
    )[0].balance;
  return {
    h,
    transactions,
    categories,
    payees,
    accruals,
    as,
    reset,
    source,
    accrue,
    scheduled,
    states,
    graph,
    bank,
    get user() {
      return user;
    },
    get account() {
      return account;
    },
    get root() {
      return root;
    },
    get child() {
      return child;
    },
    get grandchild() {
      return grandchild;
    },
    get income() {
      return income;
    },
    get other() {
      return other;
    },
    get payee() {
      return payee;
    },
    async close() {
      await settlePendingHistoryWrites();
      await h.close();
    },
  };
}
