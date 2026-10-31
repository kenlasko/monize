import { RESTORE_REFERENCE_COLUMNS } from "../restore-references";
import type { RefRule } from "./support-backup-integrity";

/** The remaining components of the schema's (id, owner/group) foreign keys. */
const SCOPES: Record<string, Record<string, readonly string[]>> = {
  shared_person_links: {
    person_id: ["user_id"],
    participant_id: ["group_id"],
  },
  shared_entries: {
    source_entry_id: ["group_id"],
    from_participant_id: ["group_id"],
    to_participant_id: ["group_id"],
  },
  shared_allocations: {
    entry_id: ["group_id"],
    participant_id: ["group_id"],
  },
  shared_activity: { entry_id: ["group_id"] },
  shared_integrations: { participant_id: ["group_id"] },
  shared_postings: {
    entry_id: ["group_id"],
    integration_id: ["user_id"],
  },
  shared_ledger_links: { posting_id: ["user_id"] },
  transactions: { shared_expense_posting_id: ["user_id"] },
};

/** Optional links may disappear without changing the journal's allocations. */
const NULLABLE_LINKS = new Set([
  "shared_groups.ownership_candidate_id",
  "shared_people.payee_id",
  "shared_activity.entry_id",
  "shared_postings.category_id",
  "shared_postings.payee_id",
  "accounts.shared_expense_group_id",
  "transactions.shared_expense_posting_id",
]);

/**
 * Derive the new FK targets from the restore's schema-checked registry.
 * Shared journals stay whole under personal-account/date scoping. A missing
 * structural reference refuses the artifact: dropping an allocation or nulling
 * a refund's source would change its financial facts or violate its CHECK.
 */
export function withSharedSupportRefs(
  core: Record<string, RefRule[]>,
): Record<string, RefRule[]> {
  const additions = Object.fromEntries(
    Object.entries(RESTORE_REFERENCE_COLUMNS).map(([table, columns]) => [
      table,
      Object.entries(columns)
        .filter(
          ([, target]) =>
            table.startsWith("shared_") || target.startsWith("shared_"),
        )
        .map(([column, refTable]): RefRule => ({
          column,
          refTable,
          onMissing: NULLABLE_LINKS.has(`${table}.${column}`)
            ? "null"
            : "error",
          ...(SCOPES[table]?.[column] ? { scope: SCOPES[table][column] } : {}),
        })),
    ]),
  );
  return Object.fromEntries(
    [...new Set([...Object.keys(core), ...Object.keys(additions)])].map(
      (table) => [table, [...(core[table] ?? []), ...(additions[table] ?? [])]],
    ),
  );
}
