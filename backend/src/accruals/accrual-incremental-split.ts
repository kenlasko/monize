import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import type { EntityManager } from "typeorm";
import { ActionHistory } from "../action-history/entities/action-history.entity";
import { MAX_JSONB_SIZE_BYTES } from "../action-history/history-limits";
import type { IncrementalSplitPreviewDto } from "../transactions/dto/incremental-split.dto";
import {
  canonical,
  resolveSourceAccrualEdit,
  type AccrualEditResolution,
} from "./accrual-source-edit";
import {
  captureAccrualHistorySnapshot,
  assertAccrualStructureRestorable,
  type AccrualHistoryState,
} from "./accrual-history-snapshot";
import { accrualErrors } from "./accrual-errors";
import { parseAccrualMoney, formatAccrualMoney } from "./accrual-money";
import { inferSplitKind } from "../transactions/split-kind.util";
import { tr } from "../i18n/translate";

type Snapshot = Record<string, unknown>;
interface Line {
  id: string;
  kind: string;
  categoryId: string | null;
  amount: string;
}
export interface IncrementalAccrualEdit {
  fingerprint: string | null;
  resolution: AccrualEditResolution;
  before?: Snapshot;
  collapse: boolean;
  activatesSplit: boolean;
  removedSourceSplitIds: string[];
}
const emptyResolution = (): AccrualEditResolution => ({
  fingerprint: null,
  impacts: [],
  retainedCategoryIds: new Map(),
  removedScheduleIds: [],
});

/** Caller holds the parent lock. No source or schedule mutation occurs here. */
export async function resolveIncrementalAccrualEdit(
  m: EntityManager,
  userId: string,
  transactionId: string,
  command: IncrementalSplitPreviewDto,
  previewOnly = false,
): Promise<IncrementalAccrualEdit> {
  if (
    (command.operation === "add" && !command.split) ||
    (command.operation === "remove" && !command.splitId) ||
    !["add", "remove"].includes(command.operation)
  )
    throw accrualErrors.conflict();
  if (command.operation === "add" && command.split?.investment) {
    throw new BadRequestException(
      tr(
        "errors.transactions.investmentSplitNoIncremental",
        "Investment splits cannot be added incrementally; replace the full split set instead.",
      ),
    );
  }
  const before: Snapshot = {};
  await captureAccrualHistorySnapshot(
    m,
    userId,
    transactionId,
    before,
    previewOnly,
  );
  const state = before.accrualState as AccrualHistoryState;
  const result: IncrementalAccrualEdit = {
    fingerprint: null,
    resolution: emptyResolution(),
    collapse: false,
    activatesSplit: false,
    removedSourceSplitIds: [],
  };
  // Existing cash-only writers retain their business validation and call shapes.
  if (!state.schedules.length && !previewOnly) return result;
  const lines = before.splits as Line[];
  const removed = new Set<string | null>();
  const patch: { categoryId?: string | null } = {};
  if (command.operation === "add") {
    const split = command.split!;
    if (state.schedules.length && inferSplitKind(split) !== "category")
      throw accrualErrors.historyUnsupported();
    const total = lines.reduce(
      (sum, line) => sum + parseAccrualMoney(line.amount),
      0n,
    );
    const next = total + parseAccrualMoney(String(split.amount));
    const parentAmount = parseAccrualMoney(String(before.amount));
    const abs = (value: bigint) => (value < 0n ? -value : value);
    if (abs(next) > abs(parentAmount)) {
      const existingTotal = formatAccrualMoney(total),
        transactionAmount = formatAccrualMoney(parentAmount);
      throw new BadRequestException(
        tr(
          "errors.transactions.splitExceedsTransactionAmount",
          `Adding this split would exceed the transaction amount. Current total: ${existingTotal}, New split: ${split.amount}, Transaction amount: ${transactionAmount}`,
          { existingTotal, newSplit: split.amount, transactionAmount },
        ),
      );
    }
    result.activatesSplit = !before.isSplit && lines.length + 1 >= 2;
    if (result.activatesSplit) removed.add(null);
  } else {
    if (!lines.some((line) => line.id === command.splitId))
      throw accrualErrors.missing();
    removed.add(command.splitId!);
    const remaining = lines.filter((line) => line.id !== command.splitId);
    result.collapse =
      remaining.length < 2 && remaining[0]?.kind !== "investment";
    if (result.collapse) {
      for (const line of remaining) removed.add(line.id);
      if (remaining[0]) patch.categoryId = remaining[0].categoryId;
    }
  }
  if (state.schedules.length) {
    assertAccrualStructureRestorable(before);
    result.resolution = await resolveSourceAccrualEdit(
      m,
      userId,
      transactionId,
      patch,
      new Map(),
      removed,
    );
    result.before = before;
    const normalized = JSON.parse(JSON.stringify(before));
    result.fingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            version: "incremental-accrual-split-v1",
            userId,
            transactionId,
            command,
            before: normalized,
            resolution: result.resolution.fingerprint,
            collapse: result.collapse,
            activatesSplit: result.activatesSplit,
          }),
        ),
      )
      .digest("hex");
  }
  result.removedSourceSplitIds = [...removed]
    .filter((id): id is string => id !== null)
    .sort();
  return result;
}

export function verifyIncrementalAccrualEdit(
  edit: IncrementalAccrualEdit,
  expected?: string,
): void {
  if (edit.fingerprint ? edit.fingerprint !== expected : expected !== undefined)
    throw accrualErrors.conflict();
}

/** Required history save is last, non-swallowing, and joins the source transaction. */
export async function recordIncrementalAccrualHistory(
  m: EntityManager,
  userId: string,
  transactionId: string,
  before: Snapshot,
): Promise<void> {
  const after: Snapshot = {};
  await captureAccrualHistorySnapshot(m, userId, transactionId, after, true);
  const size =
    Buffer.byteLength(JSON.stringify(before), "utf8") +
    Buffer.byteLength(JSON.stringify(after), "utf8");
  if (size > MAX_JSONB_SIZE_BYTES) throw accrualErrors.historyUnsupported();
  const repo = m.getRepository(ActionHistory);
  await repo.delete({ userId, isUndone: true });
  const payee = String(after.payeeName ?? ""),
    amount = `${String(after.amount)} ${String(after.currencyCode)}`;
  await repo.save(
    repo.create({
      userId,
      entityType: "transaction",
      entityId: transactionId,
      action: "update",
      beforeData: before,
      afterData: after,
      description: `Updated transaction ${payee} ${amount}`,
      descriptionKey: "updatedTransaction",
      descriptionParams: { payee, amount },
    }),
  );
}
