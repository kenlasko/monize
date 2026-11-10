import {
  BatchUpdateTransactionRow,
  UpdateTransactionDescriptor,
  UpdateTransferDescriptor,
  toSplitDtoRows,
} from "./ai-action.types";
import type { UpdateTransactionDto } from "../../transactions/dto/update-transaction.dto";
import type { UpdateTransferDto } from "../../transactions/dto/update-transfer.dto";

/**
 * What `TransactionsService.update` is called with for an approved cash edit:
 * the DTO and the options. Written once for every commit path (the confirm
 * endpoint's executor, its batch rows, and the MCP tool's direct commits), so
 * none of them can drop a field the card showed -- splits with the tags their
 * lines keep, the tags added and removed.
 */
export function updateTransactionCommitArgs(
  d: UpdateTransactionDescriptor | BatchUpdateTransactionRow,
): {
  dto: UpdateTransactionDto;
  options: {
    createPayeeIfMissing: boolean;
    addTagNames?: string[];
    removeTagIds?: string[];
  };
} {
  const referenceNumber =
    "referenceNumber" in d ? d.referenceNumber : undefined;
  const options = {
    createPayeeIfMissing: d.createPayee === true,
    ...(d.tagNames?.length ? { addTagNames: [...d.tagNames] } : {}),
    ...(d.removeTagIds?.length ? { removeTagIds: [...d.removeTagIds] } : {}),
  };
  // A tag-only edit writes the tags and no field: the snapshot the card was
  // built from must not overwrite an edit made since.
  if (d.tagsOnly) return { dto: {}, options };
  return {
    dto: {
      accountId: d.accountId,
      transactionDate: d.transactionDate,
      amount: d.amount,
      currencyCode: d.currencyCode,
      payeeId: d.payeeId ?? undefined,
      payeeName: d.payeeName ?? undefined,
      // When replacing the split set the parent keeps no single category.
      categoryId: d.splits ? undefined : (d.categoryId ?? undefined),
      description: d.description ?? undefined,
      // Only when the card sets one: a key present but undefined would clear it.
      ...(referenceNumber === undefined ? {} : { referenceNumber }),
      // Splits ride inside the same DTO so update() rebuilds the set in the
      // same transaction, under the same row lock, as the scalar fields
      // (invariant I1) -- never as a separate follow-up write.
      splits: d.splits ? toSplitDtoRows(d.splits) : undefined,
    },
    options,
  };
}

/**
 * What `TransactionsService.updateTransfer` is called with for an approved
 * transfer edit, `payeeId` being the one the caller resolved (find-or-create
 * from the label when the card says so).
 */
export function updateTransferCommitArgs(
  d: UpdateTransferDescriptor,
  payeeId: string | undefined,
): {
  dto: Partial<UpdateTransferDto>;
  tagChange: { addTagNames?: string[]; removeTagIds?: string[] };
} {
  const tagChange = {
    ...(d.tagNames?.length ? { addTagNames: [...d.tagNames] } : {}),
    ...(d.removeTagIds?.length ? { removeTagIds: [...d.removeTagIds] } : {}),
  };
  // As above: a tag-only edit writes no field of the transfer.
  if (d.tagsOnly) return { dto: {}, tagChange };
  return {
    dto: {
      amount: d.amount,
      transactionDate: d.transactionDate,
      exchangeRate: d.exchangeRate,
      toAmount: d.toAmount,
      description: d.description ?? undefined,
      payeeId,
      payeeName: d.payeeName ?? undefined,
      categoryId: d.categoryId,
    },
    tagChange,
  };
}
