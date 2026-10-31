import { sharedLedgerRefusal } from "./db/shared-ledger-refusal";
import { HttpException } from "@nestjs/common";

/**
 * Shared shape for the best-effort bulk-create paths used by the AI Assistant /
 * MCP "paste a table" flows. Each row is attempted independently: rows that
 * succeed land in `created`, rows that fail validation or persistence are
 * collected in `skipped` (by their index in the input array) with a
 * human-readable reason, rather than aborting the whole batch.
 */
export interface BulkCreateSkip {
  /** Index of the failed row within the input array. */
  index: number;
  /** Human-readable reason the row was skipped. */
  reason: string;
}

export interface BulkCreateResult<T> {
  created: T[];
  skipped: BulkCreateSkip[];
}

/**
 * Map an error thrown while creating one bulk row into a short reason for the
 * `skipped` list. Client errors (4xx) carry a safe, user-facing message and are
 * passed through; anything else is collapsed to a generic reason so internal
 * details never leak into the confirmation card.
 */
export function bulkSkipReason(error: unknown): string {
  const sharedRefusal = sharedLedgerRefusal(error);
  if (sharedRefusal) return sharedRefusal;
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status >= 400 && status < 500) {
      return error.message;
    }
  }
  return "Could not be saved.";
}

/** How many distinct reasons a failure summary spells out before counting. */
const MAX_REPORTED_REASONS = 3;

/**
 * Render why a batch produced nothing, for the tool error the model reads.
 *
 * Every bulk path already computes a per-row reason and used to discard it,
 * answering "none of the edits could be prepared -- check each transactionId"
 * instead. That sentence is a guess, and on the failure that prompted this it
 * was the wrong one: seventeen rows were refused because a split transaction's
 * categories live on its split lines and the edit resent none, and the reason
 * said exactly that, in words the model could have acted on. Told to check the
 * ids -- which were correct -- it concluded the task was impossible and gave
 * up.
 *
 * So the reasons travel. Identical reasons collapse into one line with a count
 * (a batch usually fails the same way in every row), and distinct ones are
 * listed up to {@link MAX_REPORTED_REASONS} with a tail count, so a 25-row
 * batch cannot flood the context.
 *
 * Returns "" for an empty list, so callers can append it unconditionally.
 */
export function describeSkippedRows(
  skipped: readonly BulkCreateSkip[],
  total?: number,
): string {
  if (skipped.length === 0) return "";

  const byReason = new Map<string, number[]>();
  for (const skip of skipped) {
    const rows = byReason.get(skip.reason);
    if (rows) rows.push(skip.index);
    else byReason.set(skip.reason, [skip.index]);
  }

  const count = total ?? skipped.length;
  if (byReason.size === 1) {
    const [reason] = [...byReason.keys()];
    return skipped.length === 1
      ? ` Row ${skipped[0].index + 1}: ${reason}`
      : ` All ${count} rows failed the same way: ${reason}`;
  }

  const entries = [...byReason.entries()];
  const listed = entries
    .slice(0, MAX_REPORTED_REASONS)
    // +1 so the row number matches the 1-based position a person counts.
    .map(([reason, rows]) => `Row ${rows[0] + 1}: ${reason}`)
    .join(" ");
  const remaining = entries.length - MAX_REPORTED_REASONS;
  return remaining > 0
    ? ` ${listed} (+${remaining} other reason${remaining === 1 ? "" : "s"})`
    : ` ${listed}`;
}
