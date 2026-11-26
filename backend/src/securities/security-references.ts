import { EntityManager } from "typeorm";
import { RecordInUseEntry } from "../common/helpers/record-in-use";

/** What blocks deleting a security: one entry per kind of row still using it. */
export type SecurityReferenceKind =
  | "holdings"
  | "investmentTransactions"
  | "scheduledTransactions"
  | "gemStrategies"
  | "securityDocuments";

/**
 * How deleting a security treats each column with a foreign key to
 * `securities(id)`:
 *  - `refuse`: counted; any row blocks the delete (409 RECORD_IN_USE).
 *  - `clear`: history the schema deliberately keeps with the link nulled (a
 *    strategy's past signals).
 *  - `part`: the security's own data; it goes with the security, not counted.
 *    `holdings.security_id` is refused only while the position is nonzero; a
 *    zero-quantity holding is bookkeeping that `SecuritiesService.remove`
 *    deletes first.
 *
 * Keyed `table.column`; `security-references.spec.ts` parses
 * `database/schema.sql` and fails when this and the foreign keys disagree in
 * either direction, so a migration adding a reference names this map.
 */
export const SECURITY_REFERENCES = {
  "holdings.security_id": { policy: "refuse", kind: "holdings" },
  "investment_transactions.security_id": {
    policy: "refuse",
    kind: "investmentTransactions",
  },
  "scheduled_transactions.investment_security_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
  },
  "scheduled_transaction_splits.investment_security_id": {
    policy: "refuse",
    kind: "scheduledTransactions",
  },
  "gem_strategy_assets.security_id": {
    policy: "refuse",
    kind: "gemStrategies",
  },
  // Signal history: SET NULL on purpose and no way to remove a signal.
  "gem_strategy_signals.target_security_id": { policy: "clear" },
  "security_documents.security_id": {
    policy: "refuse",
    kind: "securityDocuments",
  },
  "security_prices.security_id": { policy: "part" },
  "security_tags.security_id": { policy: "part" },
} as const satisfies Record<
  string,
  | { policy: "refuse"; kind: SecurityReferenceKind }
  | { policy: "part" | "clear" }
>;

/** Counting SQL per `refuse` column; `$1` is the user, `$2` the security. */
const COUNT_SQL: Record<string, string> = {
  // Only a nonzero position; ABS() covers a small negative left by rounding.
  "holdings.security_id":
    "SELECT count(*)::int AS count FROM holdings h JOIN accounts a ON a.id = h.account_id WHERE a.user_id = $1 AND h.security_id = $2 AND ABS(h.quantity) > 0.00000001",
  // A record read: includes VOID, a VOID row still references the security.
  "investment_transactions.security_id":
    "SELECT count(*)::int AS count FROM investment_transactions WHERE user_id = $1 AND security_id = $2",
  "scheduled_transactions.investment_security_id":
    "SELECT count(*)::int AS count FROM scheduled_transactions WHERE user_id = $1 AND investment_security_id = $2",
  "scheduled_transaction_splits.investment_security_id":
    "SELECT count(*)::int AS count FROM scheduled_transaction_splits s JOIN scheduled_transactions t ON t.id = s.scheduled_transaction_id WHERE t.user_id = $1 AND s.investment_security_id = $2",
  "gem_strategy_assets.security_id":
    "SELECT count(*)::int AS count FROM gem_strategy_assets WHERE user_id = $1 AND security_id = $2",
  "security_documents.security_id":
    "SELECT count(*)::int AS count FROM security_documents WHERE user_id = $1 AND security_id = $2",
};

/**
 * Every kind of row that still uses the security, with a count above zero. Run
 * inside the delete's transaction, after locking the security row.
 */
export async function findSecurityReferences(
  m: EntityManager,
  userId: string,
  securityId: string,
): Promise<RecordInUseEntry[]> {
  const counts = new Map<SecurityReferenceKind, number>();
  for (const [column, ref] of Object.entries(SECURITY_REFERENCES)) {
    if (ref.policy !== "refuse") continue;
    const rows: { count?: number }[] = await m.query(COUNT_SQL[column], [
      userId,
      securityId,
    ]);
    counts.set(
      ref.kind,
      (counts.get(ref.kind) ?? 0) + (Number(rows[0]?.count) || 0),
    );
  }
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => ({ kind, count }));
}
