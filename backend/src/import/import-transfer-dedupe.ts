import { Logger } from "@nestjs/common";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";
import { ImportContext } from "./import-context";
import { holdKey } from "./ofx-external-id";
import { MONEY_SCALE, roundMoney } from "../common/round.util";

/**
 * How the import tells a transfer line of the file apart from a transfer the
 * account already records, so a second download or the other account's file
 * does not write the transfer twice.
 *
 * A line without a bank id is matched by signature (date, amount, the other
 * account) and counted: two genuinely different transfers can share one, so a
 * line is a duplicate only while the lines of that signature seen so far do not
 * outnumber the rows recorded (`isDuplicateTransfer`). A line with a bank id
 * (OFX `FITID`) is not counted against other rows: it takes over the bank id
 * on one recorded transfer that has none (`adoptKeyOnRecordedTransfer`), so
 * each line claims its own row whatever order the file lists them in, and its
 * next download is skipped by the key.
 */

/** The account a transfer line names, by name and then case-insensitively. */
function transferAccountIdOf(
  ctx: ImportContext,
  transferAccount: string,
): string | undefined {
  const exact = ctx.accountMap.get(transferAccount) ?? undefined;
  if (exact) return exact;
  const lowerName = transferAccount.toLowerCase();
  for (const [name, id] of ctx.accountMap) {
    if (id && name.toLowerCase() === lowerName) return id;
  }
  return undefined;
}

/**
 * The counter keys of a transfer line: one per kind of recorded transfer it is
 * matched against (a linked leg, a split-linked row).
 */
function transferSignatureKeys(ctx: ImportContext, qifTx: any): string[] {
  if (!qifTx.isTransfer) return [];
  const keys: string[] = [];
  const transferAccountId = qifTx.transferAccount
    ? transferAccountIdOf(ctx, qifTx.transferAccount)
    : undefined;
  if (transferAccountId) {
    keys.push(`linked|${qifTx.date}|${qifTx.amount}|${transferAccountId}`);
  }
  keys.push(`split|${qifTx.date}|${qifTx.amount}`);
  return keys;
}

/** Raise a counter and answer how many lines it had counted before. */
function bumpSignature(ctx: ImportContext, sigKey: string): number {
  const seenSoFar = ctx.transferDupCounts.get(sigKey) || 0;
  ctx.transferDupCounts.set(sigKey, seenSoFar + 1);
  return seenSoFar;
}

/**
 * Give a transfer line that carries a bank id its turn in the signature
 * counters, without the counted queries. The line names a row the account
 * holds (by its key, or the one it adopts) or one it is about to write, and
 * the counted queries of a later line without a bank id see that row either
 * way, so the line must be counted as seen.
 */
export function countTransferTurn(ctx: ImportContext, qifTx: any): void {
  for (const sigKey of transferSignatureKeys(ctx, qifTx)) {
    bumpSignature(ctx, sigKey);
  }
}

/**
 * Whether a transfer line without a bank id is already recorded, from a prior
 * import or an earlier account block, by counting (see the module comment).
 */
export async function isDuplicateTransfer(
  ctx: ImportContext,
  qifTx: any,
  logger: Logger,
): Promise<boolean> {
  // Check for duplicate linked transfers using counting to avoid false positives.
  // Multiple genuinely different transfers can share the same date, amount, and
  // account pair (e.g. two $150 transfers to the same account on the same day
  // with different payees). We count how many matching linked transfers already
  // exist in the DB and how many same-signature QIF entries we have seen in this
  // block; only skip when the seen count does not exceed the existing count.
  if (qifTx.isTransfer && qifTx.transferAccount) {
    const mappedTransferAccountId = transferAccountIdOf(
      ctx,
      qifTx.transferAccount,
    );
    if (mappedTransferAccountId) {
      const existingCount = await ctx.manager
        .createQueryBuilder(Transaction, "t")
        .innerJoin(Transaction, "linked", "t.linked_transaction_id = linked.id")
        .where("t.user_id = :userId", { userId: ctx.userId })
        .andWhere("t.account_id = :accountId", {
          accountId: ctx.accountId,
        })
        .andWhere("t.is_transfer = true")
        .andWhere("t.transaction_date = :date", { date: qifTx.date })
        .andWhere("t.amount = :amount", { amount: qifTx.amount })
        .andWhere("linked.account_id = :linkedAccountId", {
          linkedAccountId: mappedTransferAccountId,
        })
        .getCount();

      // Always count every QIF entry with this signature, even when
      // existingCount is zero (fresh import). This ensures that when the
      // next entry with the same signature arrives and finds existingCount=1,
      // seenSoFar is already 1 so seenSoFar+1=2 > 1 and it is not
      // incorrectly skipped. Matches processCashTransfer counting logic.
      const seenSoFar = bumpSignature(
        ctx,
        `linked|${qifTx.date}|${qifTx.amount}|${mappedTransferAccountId}`,
      );
      if (existingCount > 0 && seenSoFar + 1 <= existingCount) {
        return true;
      }
    }
  }

  // Check for split-linked transfers (same counting approach)
  if (qifTx.isTransfer) {
    const existingCount = await ctx.manager
      .createQueryBuilder(Transaction, "t")
      .innerJoin(
        TransactionSplit,
        "split",
        "split.linked_transaction_id = t.id",
      )
      .where("t.user_id = :userId", { userId: ctx.userId })
      .andWhere("t.account_id = :accountId", {
        accountId: ctx.accountId,
      })
      .andWhere("t.is_transfer = true")
      .andWhere("t.transaction_date = :date", { date: qifTx.date })
      .andWhere("t.amount = :amount", { amount: qifTx.amount })
      .getCount();

    // Always count (same rationale as linked transfers above)
    const seenSoFar = bumpSignature(ctx, `split|${qifTx.date}|${qifTx.amount}`);
    if (existingCount > 0 && seenSoFar + 1 <= existingCount) {
      return true;
    }
  }

  return isQuickenMergedSplitTransfer(ctx, qifTx, logger);
}

/**
 * Whether the line is the receiving side of a Quicken merged split transfer.
 * Quicken merges multiple split transfers to the same account into a single
 * transaction on the receiving side (e.g. splits of $50+$40 to Account-B
 * become a single $90 in Account-B). Since we create individual split-linked
 * transactions, the merged one is a duplicate.
 */
export async function isQuickenMergedSplitTransfer(
  ctx: ImportContext,
  qifTx: any,
  logger: Logger,
): Promise<boolean> {
  if (!qifTx.isTransfer || !qifTx.transferAccount) return false;
  const mergedTransferAccountId = transferAccountIdOf(
    ctx,
    qifTx.transferAccount,
  );
  if (!mergedTransferAccountId) return false;

  const mergedGroups: Array<{
    parentId: string;
    totalAmount: string;
    splitCount: string;
  }> = await ctx.manager
    .createQueryBuilder(Transaction, "t")
    .innerJoin(TransactionSplit, "split", "split.linked_transaction_id = t.id")
    .innerJoin(Transaction, "parent", "split.transaction_id = parent.id")
    .where("t.user_id = :userId", { userId: ctx.userId })
    .andWhere("t.account_id = :accountId", {
      accountId: ctx.accountId,
    })
    .andWhere("t.transaction_date = :date", { date: qifTx.date })
    .andWhere("t.is_transfer = true")
    .andWhere("parent.account_id = :transferAccountId", {
      transferAccountId: mergedTransferAccountId,
    })
    .andWhere("parent.is_split = true")
    .select("parent.id", "parentId")
    .addSelect("SUM(t.amount)", "totalAmount")
    .addSelect("COUNT(*)", "splitCount")
    .groupBy("parent.id")
    .getRawMany();

  for (const group of mergedGroups) {
    // Compared at the storage scale: equal means the same figure at any
    // currency's precision, a coin's included.
    const total = roundMoney(Number(group.totalAmount), MONEY_SCALE);
    const expected = roundMoney(qifTx.amount, MONEY_SCALE);
    if (total === expected && Number(group.splitCount) >= 2) {
      logger.debug(
        `Skipping Quicken merged split transfer: ${qifTx.amount} on ${qifTx.date} ` +
          `(sum of ${group.splitCount} split transfers from parent ${group.parentId})`,
      );
      return true;
    }
  }
  return false;
}

/**
 * One recorded transfer of the line's signature that holds no key and was
 * written before this import: a leg the other account's import created, or a
 * row of an earlier file that carried no bank id. A row this import wrote is
 * another line of the same file, never this one.
 */
async function recordedTransferWithoutKey(
  ctx: ImportContext,
  qifTx: any,
): Promise<string | null> {
  const transferAccountId = qifTx.transferAccount
    ? transferAccountIdOf(ctx, qifTx.transferAccount)
    : undefined;
  const base = () =>
    ctx.manager
      .createQueryBuilder(Transaction, "t")
      .select("t.id", "id")
      .where("t.user_id = :userId", { userId: ctx.userId })
      .andWhere("t.account_id = :accountId", { accountId: ctx.accountId })
      .andWhere("t.is_transfer = true")
      .andWhere("t.transaction_date = :date", { date: qifTx.date })
      .andWhere("t.amount = :amount", { amount: qifTx.amount })
      .andWhere("t.external_id IS NULL")
      .andWhere("t.created_at < :importStartTime", {
        importStartTime: ctx.importStartTime,
      })
      .orderBy("t.id")
      .limit(1);

  if (transferAccountId) {
    const linked = await base()
      .innerJoin(Transaction, "linked", "t.linked_transaction_id = linked.id")
      .andWhere("linked.account_id = :linkedAccountId", {
        linkedAccountId: transferAccountId,
      })
      .getRawOne<{ id: string }>();
    if (linked) return linked.id;
  }
  // A split-linked row's other account is its split's parent: when the line
  // names an account, only a split from that account is this transfer.
  const splitLinked = base().innerJoin(
    TransactionSplit,
    "split",
    "split.linked_transaction_id = t.id",
  );
  if (transferAccountId) {
    splitLinked
      .innerJoin(Transaction, "parent", "split.transaction_id = parent.id")
      .andWhere("parent.account_id = :transferAccountId", {
        transferAccountId,
      });
  }
  const row = await splitLinked.getRawOne<{ id: string }>();
  return row?.id ?? null;
}

/**
 * For a transfer line carrying a bank id the account does not hold: store the
 * id on a recorded transfer of the same signature that has none, and answer
 * whether one took it. A line that takes over a row is that row; the next
 * download of it is skipped by the key, not counted again.
 *
 * The update is conditional on the row still holding no key, so two imports
 * reaching the same row cannot both claim it; the one that loses writes the
 * line as a new row, which the unique index then refuses if the winner holds
 * the same bank id (`isExternalIdConflict` in the import loop).
 */
export async function adoptKeyOnRecordedTransfer(
  ctx: ImportContext,
  qifTx: any,
  externalId: string,
): Promise<boolean> {
  if (!qifTx.isTransfer) return false;
  const rowId = await recordedTransferWithoutKey(ctx, qifTx);
  if (!rowId) return false;
  const result = await ctx.manager
    .createQueryBuilder()
    .update(Transaction)
    .set({ externalId })
    .where("id = :id", { id: rowId })
    .andWhere("external_id IS NULL")
    .execute();
  if (!result.affected) return false;
  holdKey(ctx.heldExternalIds, externalId, qifTx);
  return true;
}
