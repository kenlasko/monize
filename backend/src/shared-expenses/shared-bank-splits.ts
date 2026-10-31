import type { EntityManager } from "typeorm";
import type { SharedBankSplitDto } from "./dto/shared-finance.dto";
import type { SharedBankRow, SharedBankSplit } from "./shared-finance-types";
import { sharedError } from "./shared-errors";
import { fixedUnits, moneyText, sharedAmount } from "./shared-money";

/** Pick explicit portions; preserve unselected categories, memos and tags. */
export function allocateBankSplits(
  bank: SharedBankRow,
  selected: readonly SharedBankSplitDto[] | undefined,
) {
  if (!bank.isSplit) {
    if (selected) sharedError("financeSplit");
    return null;
  }
  const rows = bank.splits ?? [];
  const total = fixedUnits(bank.amount, 4, true);
  const sign = total < 0n ? -1n : 1n;
  if (
    !rows.length ||
    !selected?.length ||
    new Set(selected.map((row) => row.splitId)).size !== selected.length ||
    rows.some(
      (row) =>
        row.kind !== "category" ||
        row.transferAccountId ||
        row.linkedTransactionId ||
        row.investmentLinked,
    ) ||
    rows.reduce((sum, row) => sum + fixedUnits(row.amount, 4, true), 0n) !==
      total
  )
    sharedError("financeSplit");
  const amounts = new Map<string, bigint>();
  for (const part of selected) {
    const source = rows.find((row) => row.id === part.splitId);
    const amount = sharedAmount(part.amount, 4);
    if (
      !source ||
      amount <= 0n ||
      amount > sign * fixedUnits(source.amount, 4, true)
    )
      sharedError("financeSplit");
    amounts.set(part.splitId, sign * amount);
  }
  return {
    sharedAmount: moneyText(
      [...amounts.values()].reduce((sum, value) => sum + value, 0n),
    ),
    privateSplits: rows.flatMap((row) => {
      const remaining =
        fixedUnits(row.amount, 4, true) - (amounts.get(row.id) ?? 0n);
      return remaining === 0n ? [] : [{ ...row, amount: moneyText(remaining) }];
    }),
  };
}

/** Only stored, authorized category rows reach this writer, on the caller's manager. */
export async function restoreBankSplits(
  manager: EntityManager,
  userId: string,
  transactionId: string,
  rows: readonly SharedBankSplit[],
): Promise<void> {
  for (const row of rows) {
    await manager.query(
      `INSERT INTO transaction_splits (id, transaction_id, kind, amount, category_id, memo, created_at)
       VALUES ($1,$2,'category',$3,(SELECT id FROM categories WHERE id = $4 AND user_id = $7),$5,$6)`,
      [
        row.id,
        transactionId,
        row.amount,
        row.categoryId,
        row.memo,
        row.createdAt,
        userId,
      ],
    );
    if (row.tagIds.length) {
      await manager.query(
        `INSERT INTO transaction_split_tags (transaction_split_id, tag_id)
         SELECT $1, id FROM tags WHERE user_id = $2 AND id = ANY($3::uuid[])`,
        [row.id, userId, row.tagIds],
      );
    }
  }
}
