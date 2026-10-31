import type { Transaction } from "@/types/transaction";
import type { Account } from "@/types/account";

export function isSharedPaymentAccount(
  account: Account | null | undefined,
): boolean {
  return (
    !!account &&
    !account.isClosed &&
    !account.managedPurpose &&
    ["CHEQUING", "SAVINGS", "CASH", "CREDIT_CARD", "LINE_OF_CREDIT"].includes(
      account.accountType,
    )
  );
}

export function hasShareableBankStructure(row: Transaction): boolean {
  return (
    !row.isTransfer &&
    !row.linkedTransactionId &&
    !row.parentTransactionId &&
    !row.linkedInvestmentTransactionId &&
    !row.isReconciled &&
    !row.isVoid &&
    row.status !== "RECONCILED" &&
    row.status !== "VOID" &&
    !row.sharedExpensePostingId &&
    Number(row.amount) !== 0 &&
    (!row.isSplit ||
      (!!row.splits?.length &&
        row.splits.every(
          (split) =>
            (split.kind ?? "category") === "category" &&
            !split.transferAccountId &&
            !split.linkedTransactionId &&
            !split.investmentTransaction,
        )))
  );
}

/** An affordance only; the server rechecks the row under the account/row locks. */
export function canShareBankTransaction(
  row: Transaction,
  userId: string | undefined,
  actingAsUserId: string | null,
): boolean {
  return (
    !!userId &&
    !actingAsUserId &&
    row.userId === userId &&
    hasShareableBankStructure(row) &&
    isSharedPaymentAccount(row.account)
  );
}
