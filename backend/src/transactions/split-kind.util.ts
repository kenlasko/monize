import type { CreateTransactionSplitDto } from "./dto/create-transaction-split.dto";
import { SplitKind } from "./entities/split-kind.enum";

export function inferSplitKind(split: CreateTransactionSplitDto): SplitKind {
  if (split.splitKind) return split.splitKind;
  if (split.investment) return SplitKind.INVESTMENT;
  if (split.transferAccountId) return SplitKind.TRANSFER;
  return SplitKind.CATEGORY;
}
