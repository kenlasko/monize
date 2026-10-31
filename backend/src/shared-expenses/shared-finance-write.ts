import { randomUUID } from "crypto";
import { EntityManager } from "typeorm";
import { AccountsService } from "../accounts/accounts.service";
import { deletionBalanceEffect } from "../common/deletion-balance.util";
import { assertTransactionCurrencyMatchesAccount } from "../common/fx-entry.util";
import { SharedBankRow, SharedFinancePlan } from "./shared-finance-types";
import { fixedUnits, ledgerAmount, moneyText } from "./shared-money";
import { personalFingerprint } from "./shared-projection";
import { restoreBankSplits } from "./shared-bank-splits";

type BalanceWriter = Pick<AccountsService, "updateBalance">;

/** Restore source shapes before replacing a reviewed posting. All refusals ran in the planner. */
export async function undoSharedPosting(
  manager: EntityManager,
  balances: BalanceWriter,
  userId: string,
  plan: Pick<SharedFinancePlan, "existing" | "sourceLinks" | "sourceRows">,
  keepBankIds: readonly string[] = [],
): Promise<string[]> {
  if (!plan.existing) return [];
  const postingId = plan.existing.id;
  await manager.query("SELECT set_config('app.shared_posting_id', $1, true)", [
    postingId,
  ]);
  await manager.query(
    "DELETE FROM shared_ledger_links WHERE posting_id = $1 AND user_id = $2",
    [postingId, userId],
  );
  // Split children must be removed while the protected parent is still present.
  for (const link of plan.sourceLinks.filter((l) => l.kind === "BANK")) {
    await manager.query(
      "DELETE FROM transaction_splits WHERE transaction_id = $1",
      [link.transactionId],
    );
  }
  await manager.query(
    "UPDATE transactions SET linked_transaction_id = NULL WHERE shared_expense_posting_id = $1 AND user_id = $2",
    [postingId, userId],
  );
  const affected = new Set<string>();
  for (const link of plan.sourceLinks) {
    const row = plan.sourceRows.find((r) => r.id === link.transactionId)!;
    affected.add(row.accountId);
    if (
      link.kind === "BANK" &&
      (!link.created || keepBankIds.includes(row.id))
    ) {
      await manager.query(
        `UPDATE transactions SET is_split = $4, is_transfer = false,
        category_id = (SELECT id FROM categories WHERE id = $3 AND user_id = $2),
        shared_expense_posting_id = NULL WHERE id = $1 AND user_id = $2`,
        [
          row.id,
          userId,
          link.before?.categoryId ?? null,
          link.before?.isSplit ?? false,
        ],
      );
      await restoreBankSplits(
        manager,
        userId,
        row.id,
        link.before?.splits ?? [],
      );
    } else {
      const effect = deletionBalanceEffect({
        amount: row.amount,
        transactionDate: row.date,
        status: row.status,
      });
      if (effect.delta !== 0)
        await balances.updateBalance(row.accountId, effect.delta);
      await manager.query(
        "DELETE FROM transactions WHERE id = $1 AND user_id = $2",
        [row.id, userId],
      );
    }
  }
  return [...affected];
}

/** Each insert names its owning account's currency; no caller-supplied currency reaches the ledger. */
async function insertRow(
  manager: EntityManager,
  balances: BalanceWriter,
  userId: string,
  postingId: string,
  input: {
    accountId: string;
    currencyCode: string;
    date: string;
    amount: string;
    title: string;
    categoryId?: string | null;
    payeeId?: string | null;
    isTransfer?: boolean;
    linkedTransactionId?: string | null;
    status?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const numeric = ledgerAmount(fixedUnits(input.amount, 4, true));
  const accounts: { currency_code: string }[] = await manager.query(
    "SELECT currency_code FROM accounts WHERE id = $1 AND user_id = $2",
    [input.accountId, userId],
  );
  const currencyCode = assertTransactionCurrencyMatchesAccount(
    input.currencyCode,
    accounts[0].currency_code,
  );
  await manager.query(
    `INSERT INTO transactions (id, user_id, account_id, transaction_date, amount, currency_code, description, category_id, payee_id, is_transfer, linked_transaction_id, status, shared_expense_posting_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      id,
      userId,
      input.accountId,
      input.date,
      input.amount,
      currencyCode,
      input.title,
      input.categoryId ?? null,
      input.payeeId ?? null,
      input.isTransfer ?? false,
      input.linkedTransactionId ?? null,
      input.status ?? "UNRECONCILED",
      postingId,
    ],
  );
  if (numeric !== 0) await balances.updateBalance(input.accountId, numeric);
  return id;
}

async function linkRow(
  manager: EntityManager,
  userId: string,
  postingId: string,
  transactionId: string,
  kind: string,
  created: boolean,
  amount: string,
  before: SharedBankRow | null = null,
) {
  await manager.query(
    `INSERT INTO shared_ledger_links (user_id, posting_id, transaction_id, kind, created_by_bridge, before_shape, allocated_amount)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      userId,
      postingId,
      transactionId,
      kind,
      created,
      before ? JSON.stringify(before) : null,
      amount,
    ],
  );
}

export async function writeSharedFinance(
  manager: EntityManager,
  balances: BalanceWriter,
  userId: string,
  plan: SharedFinancePlan,
  input: Record<string, unknown>,
): Promise<{ id: string; affectedAccountIds: string[] }> {
  const postingId = plan.existing?.id ?? randomUUID();
  const affected = new Set(
    await undoSharedPosting(
      manager,
      balances,
      userId,
      plan,
      plan.payments.flatMap((payment) =>
        payment.bank ? [payment.bank.id] : [],
      ),
    ),
  );
  const snapshot = JSON.stringify({
    effect: plan.effect,
    input,
    title: plan.entry.title,
  });
  if (plan.existing) {
    await manager.query(
      `UPDATE shared_postings SET accepted_revision=$3, input_fingerprint=$4, accepted_snapshot=$5, category_id=$6, payee_id=$7 WHERE id=$1 AND user_id=$2`,
      [
        postingId,
        userId,
        plan.entry.financialRevision,
        personalFingerprint(plan.effect),
        snapshot,
        plan.categoryId,
        plan.payeeId,
      ],
    );
  } else {
    await manager.query(
      `INSERT INTO shared_postings (id,user_id,group_id,entry_id,integration_id,accepted_revision,input_fingerprint,accepted_snapshot,category_id,payee_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        postingId,
        userId,
        plan.entry.groupId,
        plan.entry.id,
        plan.integration.id,
        plan.entry.financialRevision,
        personalFingerprint(plan.effect),
        snapshot,
        plan.categoryId,
        plan.payeeId,
      ],
    );
  }
  await manager.query("SELECT set_config('app.shared_posting_id', $1, true)", [
    postingId,
  ]);
  for (const payment of plan.payments) {
    const bankDate = payment.bank?.date ?? plan.entry.date;
    const bankId =
      payment.bank?.id ??
      (await insertRow(manager, balances, userId, postingId, {
        accountId: payment.bankAccountId!,
        currencyCode: payment.bankCurrency!,
        date: bankDate,
        amount: payment.breakdown.bankTotal,
        title: plan.entry.title,
        payeeId: plan.payeeId,
      }));
    affected.add(payment.bankAccountId!);
    const counterpartAmount = moneyText(-fixedUnits(payment.cash, 4, true));
    const counterpartId = await insertRow(
      manager,
      balances,
      userId,
      postingId,
      {
        accountId: plan.integration.accountId,
        currencyCode: plan.integration.currencyCode,
        date: bankDate,
        amount: counterpartAmount,
        title: plan.entry.title,
        isTransfer: true,
        linkedTransactionId: bankId,
        status: payment.bank?.status,
      },
    );
    const split =
      payment.breakdown.privateRemainder !== "0.0000" ||
      payment.breakdown.fxDifference !== "0.0000" ||
      !!payment.privateSplits?.length;
    // The imported source and any restored prior source keep their identities;
    // only their category allocation is replaced after the accepted preview.
    if (payment.bank?.isSplit)
      await manager.query(
        "DELETE FROM transaction_splits WHERE transaction_id = $1",
        [bankId],
      );
    await manager.query(
      `UPDATE transactions SET is_transfer=$3, is_split=$4, category_id=NULL, linked_transaction_id=$5, shared_expense_posting_id=$6 WHERE id=$1 AND user_id=$2`,
      [bankId, userId, !split, split, split ? null : counterpartId, postingId],
    );
    if (split) {
      await manager.query(
        `INSERT INTO transaction_splits (transaction_id,kind,transfer_account_id,linked_transaction_id,amount) VALUES ($1,'transfer',$2,$3,$4)`,
        [
          bankId,
          plan.integration.accountId,
          counterpartId,
          payment.breakdown.agreedPortion,
        ],
      );
      for (const [amount, categoryId] of [
        ...(payment.privateSplits
          ? []
          : [[payment.breakdown.privateRemainder, payment.privateCategoryId]]),
        [payment.breakdown.fxDifference, payment.fxCategoryId],
      ]) {
        if (amount === "0.0000") continue;
        await manager.query(
          "INSERT INTO transaction_splits (transaction_id,kind,category_id,amount) VALUES ($1,'category',$2,$3)",
          [bankId, categoryId, amount],
        );
      }
      if (payment.privateSplits)
        await restoreBankSplits(manager, userId, bankId, payment.privateSplits);
    }
    const oldBank = plan.sourceLinks.find(
      (l) => l.transactionId === bankId && l.kind === "BANK",
    );
    await linkRow(
      manager,
      userId,
      postingId,
      bankId,
      "BANK",
      oldBank?.created ?? !payment.bank,
      payment.breakdown.sharedPortion,
      oldBank?.before ?? payment.bank,
    );
    await linkRow(
      manager,
      userId,
      postingId,
      counterpartId,
      "COUNTERPART",
      true,
      counterpartAmount,
    );
  }
  if (plan.effect.personal !== "0.0000") {
    const id = await insertRow(manager, balances, userId, postingId, {
      accountId: plan.integration.accountId,
      currencyCode: plan.integration.currencyCode,
      date: plan.entry.date,
      amount: plan.effect.personal,
      title: plan.entry.title,
      categoryId: plan.categoryId,
      payeeId: plan.payeeId,
    });
    await linkRow(
      manager,
      userId,
      postingId,
      id,
      "COST",
      true,
      plan.effect.personal,
    );
  }
  affected.add(plan.integration.accountId);
  // Touch even a zero-delta replacement so the existing stale-snapshot sweep
  // can recover a lost after-commit notification.
  await manager.query(
    "UPDATE accounts SET updated_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND id = ANY($2::uuid[])",
    [userId, [...affected]],
  );
  return { id: postingId, affectedAccountIds: [...affected] };
}
