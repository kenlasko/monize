import { fitMnyCategory, type MnyCategoryInput } from "./fit-mny-category";
import { randomUUID } from "node:crypto";
import { EntityManager } from "typeorm";
import { ScheduledTransaction } from "../../../scheduled-transactions/entities/scheduled-transaction.entity";
import { ScheduledTransactionSplit } from "../../../scheduled-transactions/entities/scheduled-transaction-split.entity";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { FIAT_MONEY_DECIMALS, roundMoney } from "../../../common/round.util";
import { FUNDING_ACCOUNT_ACTIONS } from "../../../securities/investment-replay.util";
import { MappedBill } from "../model/mny-import-model";
import { tagIdsFor } from "./write-tags";

/**
 * Writer for the bills the wizard selected, as Monize scheduled transactions.
 *
 * Two rules carry the history here (design section 3, issue 2):
 *
 * - **Only selected bills are written.** An unchecked bill is simply absent
 *   from the database -- never created inactive. PR #192 imported all 1,844
 *   rows and bulk-deactivated most of them, which left the user a scheduled-
 *   transactions list they had to clean by hand.
 * - **Everything imports with `auto_post = false`.** A wrongly-detected bill
 *   that only reminds is noise; one that posts money is a real error.
 */

export interface WriteBillsInput extends MnyCategoryInput {
  /** The wizard's selection -- candidates whose handle is in `options.bills`. */
  readonly bills: readonly MappedBill[];
  readonly accountIdByKey: ReadonlyMap<string, string>;
  readonly payeeIdByHandle: ReadonlyMap<number, string>;
  readonly payeeNameByHandle: ReadonlyMap<number, string>;
  readonly categoryIdByHandle: ReadonlyMap<number, string>;
  readonly securityIdByHandle: ReadonlyMap<number, string>;
  /** Account key -> its investment-pair partner, for funding accounts. */
  readonly linkedKeyByKey: ReadonlyMap<string, string>;
  /** Classification item (`CAT.hcat`) -> Monize tag id, from `writeTags`. */
  readonly tagIdByHandle: ReadonlyMap<number, string>;
  /** Currency code -> the places a bill's amounts are written at; absent: four (Money). */
  readonly moneyPlaces?: ReadonlyMap<string, number>;
}

export interface WrittenBills {
  readonly created: number;
  /** Bills matched to a schedule that already existed, so not re-created. */
  readonly reused: number;
}

/** Identity a re-import recognises: same account, name, amount and cadence. */
function reuseKey(
  accountId: string,
  name: string,
  amount: number,
  frequency: string,
): string {
  return `${accountId}|${name.toLowerCase()}|${roundMoney(amount)}|${frequency}`;
}

export async function writeBills(
  manager: EntityManager,
  userId: string,
  input: WriteBillsInput,
): Promise<WrittenBills> {
  const repo = manager.getRepository(ScheduledTransaction);
  const splitRepo = manager.getRepository(ScheduledTransactionSplit);
  let created = 0;
  let reused = 0;

  const existing = await repo.find({
    where: { userId },
    select: ["id", "accountId", "name", "amount", "frequency"],
  });
  const existingKeys = new Set(
    existing.map((row) =>
      reuseKey(row.accountId, row.name, Number(row.amount), row.frequency),
    ),
  );

  for (const bill of input.bills) {
    const places =
      input.moneyPlaces?.get(bill.currencyCode) ?? FIAT_MONEY_DECIMALS;
    const accountId = input.accountIdByKey.get(bill.accountKey);
    if (!accountId) {
      continue;
    }

    const key = reuseKey(accountId, bill.name, bill.amount, bill.frequency);
    if (existingKeys.has(key)) {
      reused += 1;
      continue;
    }
    existingKeys.add(key);

    const payeeId =
      bill.payeeHandle === null
        ? null
        : (input.payeeIdByHandle.get(bill.payeeHandle) ?? null);
    const payeeName =
      bill.payeeHandle === null
        ? null
        : (input.payeeNameByHandle.get(bill.payeeHandle) ?? null);
    const transferAccountId =
      bill.transferAccountKey === null
        ? null
        : (input.accountIdByKey.get(bill.transferAccountKey) ?? null);
    // A scheduled transfer takes a category of any type, a scheduled
    // ordinary transaction only Income or Expense (INV-CATEGORY-001).
    const categoryId = fitMnyCategory(
      input,
      bill.categoryHandle,
      bill.isTransfer ? "transfer" : "category",
    );

    const investment = bill.investment;
    const securityId =
      investment === null
        ? null
        : (input.securityIdByHandle.get(investment.securityHandle) ?? null);
    // A funding account only belongs on a BUY/SELL; every other action settles
    // against the brokerage's linked cash account. Persisting one on, say, an
    // imported DIVIDEND leaves the same stale column the scheduled-transaction
    // service now clears on write, so gate it on the action here too (#1154).
    const fundingKey = input.linkedKeyByKey.get(bill.accountKey);
    const fundingAccountId =
      investment === null ||
      fundingKey === undefined ||
      !FUNDING_ACCOUNT_ACTIONS.has(investment.action)
        ? null
        : (input.accountIdByKey.get(fundingKey) ?? null);

    const id = randomUUID();
    await repo.insert({
      id,
      userId,
      accountId,
      name: bill.name,
      payeeId,
      payeeName,
      categoryId,
      amount: roundMoney(bill.amount, places),
      currencyCode: bill.currencyCode,
      description: bill.description,
      frequency: bill.frequency,
      nextDueDate: bill.nextDueDate,
      startDate: bill.nextDueDate,
      endDate: bill.endDate,
      isActive: true,
      autoPost: false,
      isSplit: bill.splits.length > 0,
      isTransfer: bill.isTransfer,
      transferAccountId,
      isInvestment: investment !== null,
      investmentAction: investment?.action ?? null,
      investmentSecurityId: securityId,
      investmentFundingAccountId: fundingAccountId,
      investmentQuantity: investment?.quantity ?? null,
      investmentPrice: investment?.price ?? null,
      investmentCommission: investment === null ? null : investment.commission,
      investmentTotalAmount:
        investment === null ? null : roundMoney(Math.abs(bill.amount), places),
      customRecurrence: bill.customRecurrence ?? null,
      tagIds: tagIdsFor(bill.tagHandles, input.tagIdByHandle),
    });

    for (const split of bill.splits) {
      const splitTransferAccountId =
        split.transferAccountKey === null
          ? null
          : (input.accountIdByKey.get(split.transferAccountKey) ?? null);
      await splitRepo.insert({
        id: randomUUID(),
        scheduledTransactionId: id,
        // A transfer leg whose account did not import falls back to a category
        // leg, keeping the schedule's total intact.
        kind:
          split.kind === SplitKind.TRANSFER && splitTransferAccountId === null
            ? SplitKind.CATEGORY
            : split.kind,
        categoryId: fitMnyCategory(
          input,
          split.categoryHandle,
          split.kind === SplitKind.TRANSFER && splitTransferAccountId !== null
            ? "transfer"
            : "category",
        ),
        transferAccountId: splitTransferAccountId,
        amount: roundMoney(split.amount, places),
        memo: split.memo,
      });
    }

    created += 1;
  }

  return { created, reused };
}
