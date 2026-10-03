import { TableMap } from "./support-backup-scope";

/**
 * Referential-integrity scrub for trimmed exports. Account scoping and date
 * ranges remove rows; any foreign key still pointing at a removed row would
 * make the file unrestorable (the restore inserts most FKs inline and
 * re-applies the deferred ones with an unconditional UPDATE). Instead of
 * patching individual columns per feature, this pass walks a declarative map
 * of every FK between exported tables and repairs each dangling reference:
 *
 * - `null`: clear the column (nullable FKs -- lost cross-link, row survives),
 * - `dropRow`: remove the row (NOT NULL FKs, junction rows, or rows that are
 *   meaningless without their target, e.g. a transfer split whose target
 *   account is gone -- keeping it with a null would violate a CHECK
 *   constraint).
 *
 * The map lists physical FKs from database/schema.sql between tables that the
 * support backup exports. FKs to `users` and `currencies` are excluded: users
 * is never exported (restore rescopes user_id) and currencies are restored by
 * code, not by id.
 */
export interface RefRule {
  column: string;
  refTable: string;
  onMissing: "null" | "dropRow";
}

const REFS: Record<string, RefRule[]> = {
  categories: [
    { column: "parent_id", refTable: "categories", onMissing: "null" },
  ],
  payees: [
    {
      column: "default_category_id",
      refTable: "categories",
      onMissing: "null",
    },
  ],
  payee_aliases: [
    { column: "payee_id", refTable: "payees", onMissing: "dropRow" },
  ],
  // A parser outlives its payee (the column is ON DELETE SET NULL), so a payee
  // the file does not carry clears the reference instead of dropping the parser.
  email_receipt_parsers: [
    { column: "payee_id", refTable: "payees", onMissing: "null" },
  ],
  // transaction_attachments.transaction_id is a real FK (the entity models the
  // relation) between two fully-exported tables, so the coverage guard requires
  // it here even though the de-identified support backup excludes the table. A
  // row cannot outlive its parent transaction, hence dropRow. (attachment_blobs
  // .attachment_id is a plain PrimaryColumn, not a modeled relation, so it is
  // not a real FK in the entity-synced test DB -- adding a REFS entry for it
  // would trip the staleRefs guard.)
  transaction_attachments: [
    {
      column: "transaction_id",
      refTable: "transactions",
      onMissing: "dropRow",
    },
    // A scan pair's original points at the visible attachment it was scanned
    // from (INV-ATTACHMENT-002). `null` rather than `dropRow`, and the reason
    // is structural: a self-referential `dropRow` is a cycle to the pass-bound
    // guard, which cannot bound a chain whose length depends on the data
    // (`support-backup-integrity.spec.ts`) -- which is why every other
    // self-referential rule here nulls too. Nothing is lost by it, because the
    // dangling case cannot arise: both halves of a pair carry the same
    // `transaction_id`, so the rule above removes them together or not at all.
    // The table is in `ALWAYS_EXCLUDED_TABLES` besides, so this entry exists to
    // satisfy the coverage guard, which is driven by the FULL backup's table
    // set rather than the support export's.
    {
      column: "original_of_attachment_id",
      refTable: "transaction_attachments",
      onMissing: "null",
    },
  ],
  // The nullable source FK is modeled by the entity and covered by the live-FK
  // integration guard. A reminder retains its template after source deletion;
  // the cron stops it when it sees the null reference.
  notification_reminders: [
    {
      column: "source_notification_id",
      refTable: "notifications",
      onMissing: "null",
    },
  ],
  accounts: [
    { column: "linked_account_id", refTable: "accounts", onMissing: "null" },
    {
      column: "linked_loan_account_id",
      refTable: "accounts",
      onMissing: "null",
    },
    { column: "source_account_id", refTable: "accounts", onMissing: "null" },
    { column: "institution_id", refTable: "institutions", onMissing: "null" },
    {
      column: "principal_category_id",
      refTable: "categories",
      onMissing: "null",
    },
    {
      column: "interest_category_id",
      refTable: "categories",
      onMissing: "null",
    },
    { column: "asset_category_id", refTable: "categories", onMissing: "null" },
    {
      column: "overpayment_category_id",
      refTable: "categories",
      onMissing: "null",
    },
    { column: "overpayment_payee_id", refTable: "payees", onMissing: "null" },
    {
      column: "scheduled_transaction_id",
      refTable: "scheduled_transactions",
      onMissing: "null",
    },
  ],
  transactions: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
    { column: "payee_id", refTable: "payees", onMissing: "null" },
    { column: "category_id", refTable: "categories", onMissing: "null" },
    {
      column: "parent_transaction_id",
      refTable: "transactions",
      onMissing: "null",
    },
    {
      column: "linked_transaction_id",
      refTable: "transactions",
      onMissing: "null",
    },
  ],
  transaction_splits: [
    {
      column: "transaction_id",
      refTable: "transactions",
      onMissing: "dropRow",
    },
    { column: "category_id", refTable: "categories", onMissing: "null" },
    // A transfer split without its target violates chk_split_kind_exclusive,
    // so the row goes rather than the column.
    {
      column: "transfer_account_id",
      refTable: "accounts",
      onMissing: "dropRow",
    },
    {
      column: "linked_transaction_id",
      refTable: "transactions",
      onMissing: "null",
    },
  ],
  transaction_tags: [
    {
      column: "transaction_id",
      refTable: "transactions",
      onMissing: "dropRow",
    },
    { column: "tag_id", refTable: "tags", onMissing: "dropRow" },
  ],
  transaction_split_tags: [
    {
      column: "transaction_split_id",
      refTable: "transaction_splits",
      onMissing: "dropRow",
    },
    { column: "tag_id", refTable: "tags", onMissing: "dropRow" },
  ],
  scheduled_transactions: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
    { column: "payee_id", refTable: "payees", onMissing: "null" },
    { column: "category_id", refTable: "categories", onMissing: "null" },
    { column: "transfer_account_id", refTable: "accounts", onMissing: "null" },
    {
      column: "investment_security_id",
      refTable: "securities",
      onMissing: "null",
    },
    {
      column: "investment_funding_account_id",
      refTable: "accounts",
      onMissing: "null",
    },
  ],
  scheduled_transaction_splits: [
    {
      column: "scheduled_transaction_id",
      refTable: "scheduled_transactions",
      onMissing: "dropRow",
    },
    { column: "category_id", refTable: "categories", onMissing: "null" },
    {
      column: "transfer_account_id",
      refTable: "accounts",
      onMissing: "dropRow",
    },
    {
      column: "investment_security_id",
      refTable: "securities",
      onMissing: "null",
    },
  ],
  scheduled_transaction_overrides: [
    {
      column: "scheduled_transaction_id",
      refTable: "scheduled_transactions",
      onMissing: "dropRow",
    },
    { column: "category_id", refTable: "categories", onMissing: "null" },
  ],
  scheduled_transaction_postings: [
    {
      // `dropRow`, like the overrides above: the posting has no meaning without
      // the schedule whose occurrence it records, and the column is NOT NULL.
      column: "scheduled_transaction_id",
      refTable: "scheduled_transactions",
      onMissing: "dropRow",
    },
  ],
  scheduled_transaction_split_tags: [
    {
      column: "scheduled_transaction_split_id",
      refTable: "scheduled_transaction_splits",
      onMissing: "dropRow",
    },
    { column: "tag_id", refTable: "tags", onMissing: "dropRow" },
  ],
  security_prices: [
    { column: "security_id", refTable: "securities", onMissing: "dropRow" },
  ],
  security_documents: [
    { column: "security_id", refTable: "securities", onMissing: "dropRow" },
  ],
  security_tags: [
    { column: "security_id", refTable: "securities", onMissing: "dropRow" },
    { column: "tag_id", refTable: "tags", onMissing: "dropRow" },
  ],
  holdings: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
    { column: "security_id", refTable: "securities", onMissing: "dropRow" },
  ],
  investment_transactions: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
    { column: "transaction_id", refTable: "transactions", onMissing: "null" },
    {
      column: "transaction_split_id",
      refTable: "transaction_splits",
      onMissing: "null",
    },
    {
      column: "linked_transaction_id",
      refTable: "investment_transactions",
      onMissing: "null",
    },
    { column: "security_id", refTable: "securities", onMissing: "null" },
    { column: "funding_account_id", refTable: "accounts", onMissing: "null" },
  ],
  loan_rate_changes: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
  ],
  loan_scenarios: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
  ],
  budget_categories: [
    { column: "budget_id", refTable: "budgets", onMissing: "dropRow" },
    { column: "category_id", refTable: "categories", onMissing: "null" },
    { column: "transfer_account_id", refTable: "accounts", onMissing: "null" },
  ],
  budget_periods: [
    { column: "budget_id", refTable: "budgets", onMissing: "dropRow" },
  ],
  budget_period_categories: [
    {
      column: "budget_period_id",
      refTable: "budget_periods",
      onMissing: "dropRow",
    },
    {
      column: "budget_category_id",
      refTable: "budget_categories",
      onMissing: "dropRow",
    },
    { column: "category_id", refTable: "categories", onMissing: "null" },
  ],
  notifications: [
    { column: "budget_id", refTable: "budgets", onMissing: "null" },
    {
      column: "budget_category_id",
      refTable: "budget_categories",
      onMissing: "null",
    },
  ],
  monthly_account_balances: [
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
  ],
  monte_carlo_cash_flows: [
    {
      column: "scenario_id",
      refTable: "monte_carlo_scenarios",
      onMissing: "dropRow",
    },
  ],
  gem_strategy_accounts: [
    {
      column: "strategy_id",
      refTable: "gem_strategies",
      onMissing: "dropRow",
    },
    { column: "account_id", refTable: "accounts", onMissing: "dropRow" },
  ],
  gem_strategy_assets: [
    {
      column: "strategy_id",
      refTable: "gem_strategies",
      onMissing: "dropRow",
    },
    // A role whose instrument is gone is exactly what an unmapped role is, so
    // the row survives with a null rather than disappearing.
    { column: "security_id", refTable: "securities", onMissing: "null" },
  ],
  gem_strategy_signals: [
    {
      column: "strategy_id",
      refTable: "gem_strategies",
      onMissing: "dropRow",
    },
    {
      column: "target_security_id",
      refTable: "securities",
      onMissing: "null",
    },
  ],
};

/**
 * Exposed for the integration completeness guard, which asserts REFS covers
 * every foreign key between exported tables (mirroring the golden column test
 * for RULES). Not part of the runtime API.
 */
export const REFS_FOR_TEST: ReadonlyMap<
  string,
  ReadonlyArray<RefRule>
> = new Map(Object.entries(REFS).map(([table, rules]) => [table, [...rules]]));

/**
 * Passes the reference scrub is allowed before it declares failure.
 *
 * Dropping a row can orphan its own dependents, so the scrub iterates. The
 * dependency graph between exported tables is a few levels deep, so this is
 * generous; it is a runaway guard, not a tuning knob.
 */
export const MAX_SCRUB_PASSES = 10;

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * One dangling-reference fixed-point computation, parameterised by the rule map
 * and the pass bound.
 *
 * Split out of `scrubDanglingRefs` so the bound is reachable from a test: with
 * the real `REFS` the graph is four levels deep and no input can drive the loop
 * to ten passes, which is exactly the state in which a silent `break` looks
 * correct forever. The rule that matters here is not "ten is enough" but
 * "running out of passes is an error", and that can only be asserted against a
 * map deep enough to run out.
 *
 * @throws when the loop exhausts `maxPasses` with work still outstanding.
 */
export function scrubToFixedPoint(
  tables: TableMap,
  refs: Record<string, RefRule[]>,
  maxPasses: number,
): TableMap {
  const out: TableMap = { ...tables };

  // Present-id sets are cached across passes and only the tables that actually
  // lost rows in a pass are invalidated -- a late pass typically drops a few
  // junction rows and shouldn't rebuild the (large, unchanged) transactions
  // set. `changedTables` also drives convergence: an empty set means fixpoint.
  const idSets = new Map<string, Set<string>>();
  const idsOf = (table: string): Set<string> => {
    let ids = idSets.get(table);
    if (!ids) {
      ids = new Set(
        (out[table] ?? [])
          .map((row) => str(row.id))
          .filter((id): id is string => id !== null),
      );
      idSets.set(table, ids);
    }
    return ids;
  };

  let converged = false;
  for (let pass = 0; pass < maxPasses; pass++) {
    const changedTables = new Set<string>();

    for (const [table, rules] of Object.entries(refs)) {
      const rows = out[table];
      if (!rows || rows.length === 0) continue;

      let tableChanged = false;
      const next: Record<string, unknown>[] = [];
      for (const row of rows) {
        const toNull = rules.filter((rule) => {
          const ref = str(row[rule.column]);
          return ref !== null && !idsOf(rule.refTable).has(ref);
        });
        if (toNull.some((rule) => rule.onMissing === "dropRow")) {
          tableChanged = true;
          continue;
        }
        if (toNull.length === 0) {
          next.push(row);
          continue;
        }
        tableChanged = true;
        next.push({
          ...row,
          ...Object.fromEntries(toNull.map((rule) => [rule.column, null])),
        });
      }
      if (tableChanged) {
        out[table] = next;
        // This table's id set shrank, so any reference to it must re-check.
        idSets.delete(table);
        changedTables.add(table);
      }
    }

    if (changedTables.size === 0) {
      converged = true;
      break;
    }
  }

  // Reaching the bound means the last pass still had work to do, so references
  // may still dangle. Silence here would be the worst outcome available: the
  // support backup is a *restorable* artifact, and shipping one that is known
  // not to be referentially closed hands the recipient a file that fails on
  // insert with no hint that the export knew. The dependency graph is shallow
  // (a handful of levels), so this is unreachable today -- which is exactly why
  // it must announce itself rather than degrade quietly if that ever changes.
  if (!converged) {
    throw new Error(
      `Support backup reference scrub did not reach a fixed point in ${maxPasses} passes; ` +
        "the export would contain dangling references and could not be restored.",
    );
  }

  return out;
}

/**
 * Repairs every dangling reference in the (possibly trimmed) table map.
 * Iterates to a fixed point because dropping a row can orphan its own
 * dependents (e.g. dropping a transfer split orphans its split-tag rows);
 * the dependency graph is shallow, so this converges in a few passes.
 *
 * Also scopes the id arrays that live outside FK constraints:
 * `monte_carlo_scenarios.account_ids` is filtered to accounts present in the
 * file (a plain UUID[] with no FK -- stale entries would leak the user's real
 * account ids un-remapped), and `custom_reports.filters` id arrays are
 * filtered for the same reason (the JSONB rule keeps them otherwise).
 */
export function scrubDanglingRefs(tables: TableMap): TableMap {
  const out = scrubToFixedPoint(tables, REFS, MAX_SCRUB_PASSES);

  const accountIds = new Set(
    (out.accounts ?? []).map((a) => str(a.id)).filter(Boolean),
  );
  out.monte_carlo_scenarios = (out.monte_carlo_scenarios ?? []).map((s) =>
    Array.isArray(s.account_ids)
      ? {
          ...s,
          account_ids: s.account_ids.filter((id) => accountIds.has(str(id))),
        }
      : s,
  );
  out.custom_reports = (out.custom_reports ?? []).map((report) => {
    const filters = report.filters;
    if (typeof filters !== "object" || filters === null) return report;
    const scoped = { ...(filters as Record<string, unknown>) };
    if (Array.isArray(scoped.accountIds)) {
      scoped.accountIds = scoped.accountIds.filter((id) =>
        accountIds.has(str(id)),
      );
    }
    return { ...report, filters: scoped };
  });

  return out;
}

/**
 * A masked text column that carries a UNIQUE constraint. Masking is not
 * injective (short values collapse to all-asterisks, and any two values
 * sharing their first/last two characters and length coincide), so two
 * originally-distinct rows can end up with the same masked value. On restore
 * that collides on the UNIQUE index and `INSERT ... ON CONFLICT DO NOTHING`
 * silently drops the second row -- orphaning its children (e.g. a dropped
 * payee leaves its NOT NULL payee_aliases pointing at nothing, which fails the
 * FK). `dedupeMaskedText` restores uniqueness by suffixing collisions.
 *
 * `groupBy` lists the other columns of the unique key (besides user_id, which
 * is constant across a single user's export): a value need only be unique
 * within its group (e.g. a category name per parent). `caseInsensitive` mirrors
 * a `LOWER(col)` unique index. `maxLen` caps the column's varchar width so the
 * suffix truncates the base instead of overflowing it.
 */
interface UniqueTextKey {
  column: string;
  groupBy?: string[];
  caseInsensitive?: boolean;
  maxLen?: number;
}

const UNIQUE_MASKED_TEXT: Record<string, UniqueTextKey[]> = {
  payees: [{ column: "name" }],
  categories: [{ column: "name", groupBy: ["parent_id"] }],
  tags: [{ column: "name", caseInsensitive: true }],
  institutions: [{ column: "name" }],
  payee_aliases: [{ column: "alias", caseInsensitive: true }],
  securities: [{ column: "symbol", maxLen: 20 }],
  loan_scenarios: [
    { column: "name", groupBy: ["account_id"], caseInsensitive: true },
  ],
  import_column_mappings: [{ column: "name", maxLen: 100 }],
};

/**
 * Exposed for the integration completeness guard, which asserts this map covers
 * every UNIQUE index over a masked text column (mirroring the golden guards for
 * RULES and REFS). Not part of the runtime API.
 */
export const UNIQUE_MASKED_TEXT_FOR_TEST: ReadonlyMap<
  string,
  ReadonlyArray<{ column: string }>
> = new Map(
  Object.entries(UNIQUE_MASKED_TEXT).map(([table, keys]) => [
    table,
    keys.map((k) => ({ column: k.column })),
  ]),
);

/** Appends a ` (n)` disambiguator, truncating the base to fit `maxLen`. */
function withSuffix(base: string, n: number, maxLen?: number): string {
  const suffix = ` (${n})`;
  if (maxLen === undefined || base.length + suffix.length <= maxLen) {
    return base + suffix;
  }
  return base.slice(0, Math.max(0, maxLen - suffix.length)) + suffix;
}

/**
 * Joins the `groupBy` column values into one map key. A character that cannot
 * occur in any of them, so ("a", "b") and ("a b", "") stay distinct groups --
 * a printable separator would fold two different unique-key groups into one and
 * suffix a name that did not actually collide.
 *
 * Written as an escape, not as the byte itself: the literal control character
 * used to sit in this file, which made `grep`, `file` and every other text tool
 * classify the source as binary and skip it -- so a source-scanning guard test
 * silently stopped covering it. `source-bytes.spec.ts` now fails on any
 * source file carrying a raw control byte.
 */
const GROUP_SEPARATOR = "\u0000";

function dedupeColumn(
  rows: Record<string, unknown>[],
  key: UniqueTextKey,
): Record<string, unknown>[] {
  const fold = (s: string): string =>
    key.caseInsensitive ? s.toLowerCase() : s;
  const seenByGroup = new Map<string, Set<string>>();
  return rows.map((row) => {
    const value = row[key.column];
    if (typeof value !== "string") return row;
    const group = (key.groupBy ?? [])
      .map((c) => String(row[c] ?? ""))
      .join(GROUP_SEPARATOR);
    let seen = seenByGroup.get(group);
    if (!seen) {
      seen = new Set();
      seenByGroup.set(group, seen);
    }
    if (!seen.has(fold(value))) {
      seen.add(fold(value));
      return row;
    }
    let n = 2;
    let candidate = withSuffix(value, n, key.maxLen);
    while (seen.has(fold(candidate))) {
      candidate = withSuffix(value, ++n, key.maxLen);
    }
    seen.add(fold(candidate));
    return { ...row, [key.column]: candidate };
  });
}

/**
 * Makes every masked value on a UNIQUE column distinct again so the file
 * restores without `ON CONFLICT DO NOTHING` silently dropping a collided row.
 * Runs on every export (collisions are a property of masking, independent of
 * any trimming), and only touches display text -- ids (the FK targets) are
 * untouched, so referential integrity is preserved.
 */
export function dedupeMaskedText(tables: TableMap): TableMap {
  const out = { ...tables };
  for (const [table, keys] of Object.entries(UNIQUE_MASKED_TEXT)) {
    const rows = out[table];
    if (!rows || rows.length === 0) continue;
    let current = rows;
    for (const key of keys) current = dedupeColumn(current, key);
    out[table] = current;
  }
  return out;
}
