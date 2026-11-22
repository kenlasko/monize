import { ConflictException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { tr } from "../i18n/translate";

/**
 * The refusal for a write that would change what an investment transaction of
 * a deactivated security contributes (issue #2323).
 *
 * Deactivation requires the security to hold no shares
 * (`SecuritiesService.deactivate`). A later edit, deletion, void or new row
 * could move the position off zero while the security stays inactive, which
 * the person can then neither see in the active lists nor reason about. So the
 * security is activated first, deliberately, and its rows change after.
 */
export function inactiveSecurityLockedError(symbol: string): ConflictException {
  return new ConflictException(
    tr(
      "errors.securities.inactiveSecurityLocked",
      `${symbol} is deactivated, so its investment transactions cannot be added, changed or deleted. Activate ${symbol} on the Securities page first.`,
      { symbol },
    ),
  );
}

/**
 * The same refusal for a security already loaded, for a preview that tells the
 * person before the write's transaction would.
 */
export function assertSecurityActive(security: {
  symbol: string;
  isActive: boolean;
}): void {
  if (security.isActive === false) {
    throw inactiveSecurityLockedError(security.symbol);
  }
}

/**
 * Refuse the write when any of these securities is deactivated. Null and
 * undefined ids (a cash-only action) are skipped.
 *
 * Called inside the write's transaction, after `lockHoldingScope`, so the
 * refusal precedes every write and rolls back with it. The rows are read
 * `FOR KEY SHARE`, the lock the investment row's foreign key takes on the
 * security anyway, taken here before the read rather than at the insert.
 * `SecuritiesService.deactivate` locks the same row `FOR UPDATE`, which
 * conflicts with it: a deactivation that arrives first makes this read wait
 * and, under READ COMMITTED, return the inactive row; one that arrives second
 * waits for this write to commit and its holdings check, a later statement on
 * a fresh snapshot, sees the shares this write left. Lock order: the
 * deactivation takes no other lock, so it never waits on anything a writer
 * holds while the writer waits on it: no cycle.
 */
export async function assertSecuritiesActiveIn(
  manager: EntityManager,
  userId: string,
  securityIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const ids = [
    ...new Set(
      securityIds.filter((id): id is string => typeof id === "string"),
    ),
  ].sort();
  if (ids.length === 0) return;
  const rows: Array<{ symbol: string; is_active: boolean }> =
    await manager.query(
      `SELECT symbol, is_active FROM securities
        WHERE id = ANY($1::uuid[]) AND user_id = $2
        ORDER BY id
        FOR KEY SHARE`,
      [ids, userId],
    );
  const inactive = rows.find((row) => row.is_active === false);
  if (inactive) throw inactiveSecurityLockedError(inactive.symbol);
}
