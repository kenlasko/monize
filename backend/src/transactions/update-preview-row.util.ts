import {
  AiActionPreviewRow,
  ResolvedSplitLine,
  toSplitPreview,
} from "../ai/actions/ai-action.types";
import { transferPreviewRow } from "../ai/actions/ai-action-builder.service";
import {
  splitTagChangeDisplayFields,
  tagChangeDisplayFields,
} from "../tags/tag-change.util";
import { UpdateTransferPreview } from "./transaction-transfer.service";
import { UpdateTransactionPreview } from "./transactions.service";

/** A resolved edit, as `TransactionToolPrepService.prepareUpdate` returns it. */
export type ResolvedUpdate =
  | {
      kind: "standard";
      preview: UpdateTransactionPreview;
      splits?: ResolvedSplitLine[];
    }
  | { kind: "transfer"; preview: UpdateTransferPreview };

/**
 * The display row for one resolved edit: what its card shows, and what a
 * dryRun returns for it. A row that replaces a split set shows its lines
 * instead of a single category name, because that is what it writes.
 */
export function updatePreviewRow(result: ResolvedUpdate): AiActionPreviewRow {
  if (result.kind === "transfer") {
    return {
      ...transferPreviewRow(result.preview),
      ...tagChangeDisplayFields(result.preview),
    };
  }
  const { preview, splits } = result;
  return {
    status: "ok",
    accountName: preview.accountName,
    amount: preview.amount,
    currencyCode: preview.currencyCode,
    transactionDate: preview.transactionDate,
    payeeName: preview.payeeName,
    payeeWillBeCreated: preview.payeeWillBeCreated,
    categoryName: splits ? null : preview.categoryName,
    description: preview.description,
    isReconciled: preview.isReconciled,
    ...(splits ? { splits: splits.map(toSplitPreview) } : {}),
    ...tagChangeDisplayFields(preview),
    ...splitTagChangeDisplayFields(preview),
  };
}
