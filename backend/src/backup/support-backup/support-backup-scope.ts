export type TableMap = Record<string, Record<string, unknown>[]>;

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/**
 * Narrows the export to a chosen set of accounts and their referential
 * closure, so a user can share only the account a bug concerns.
 *
 * Dimension tables that are not account-specific -- categories, payees,
 * payee_aliases, tags, institutions, securities, security_prices, currencies,
 * budgets and reports -- are kept whole. Their content is already masked and
 * keeping them intact guarantees no dangling FK; the scope's purpose is to cut
 * the volume and range of transactional data, which the account-scoped tables
 * below deliver. Account-to-account FKs on pulled-in "shell" counterparties
 * (and budget transfer targets) are reset when they would dangle, so the
 * trimmed file still restores.
 */
export function scopeToAccounts(
  tables: TableMap,
  accountIds: string[],
): TableMap {
  const accounts = tables.accounts ?? [];
  const byId = new Map(accounts.map((a) => [str(a.id), a] as const));

  // Primary accounts: the selection plus the accounts it is directly linked to
  // (cash<->brokerage pairs, loan payment source, loan<->asset links).
  const primary = new Set<string>(accountIds);
  const LINK_COLS = [
    "linked_account_id",
    "linked_loan_account_id",
    "source_account_id",
  ];
  for (const id of accountIds) {
    const acc = byId.get(id);
    if (!acc) continue;
    for (const col of LINK_COLS) {
      const ref = str(acc[col]);
      if (ref && byId.has(ref)) primary.add(ref);
    }
  }

  // Transactions on primary accounts, plus the transfer/parent legs they point
  // at, so a transfer is never half-exported.
  const allTx = tables.transactions ?? [];
  const txById = new Map(allTx.map((t) => [str(t.id), t] as const));
  const keptTxIds = new Set<string>();
  const stack: Record<string, unknown>[] = [];
  for (const t of allTx) {
    if (primary.has(str(t.account_id) ?? "")) {
      const id = str(t.id);
      if (id && !keptTxIds.has(id)) {
        keptTxIds.add(id);
        stack.push(t);
      }
    }
  }
  while (stack.length > 0) {
    const t = stack.pop()!;
    for (const col of ["linked_transaction_id", "parent_transaction_id"]) {
      const ref = str(t[col]);
      if (ref && !keptTxIds.has(ref) && txById.has(ref)) {
        keptTxIds.add(ref);
        stack.push(txById.get(ref)!);
      }
    }
  }
  const keptTx = allTx.filter((t) => keptTxIds.has(str(t.id) ?? ""));

  const keptSplits = (tables.transaction_splits ?? []).filter((s) =>
    keptTxIds.has(str(s.transaction_id) ?? ""),
  );
  const keptSplitIds = new Set(keptSplits.map((s) => str(s.id)));

  // Shell accounts: transfer counterparties referenced by the kept rows that
  // aren't primary. Their own transactions are NOT pulled in.
  const shell = new Set<string>();
  const noteAccount = (ref: string | null) => {
    if (ref && !primary.has(ref) && byId.has(ref)) shell.add(ref);
  };
  for (const t of keptTx) noteAccount(str(t.account_id));
  for (const s of keptSplits) noteAccount(str(s.transfer_account_id));

  const keptAccounts = new Set<string>([...primary, ...shell]);
  const inScope = (ref: unknown) => keptAccounts.has(str(ref) ?? "");

  // Shell accounts may carry account-to-account FKs pointing outside the scope;
  // the restore re-applies those deferred FKs without an existence check, so
  // null any that would dangle.
  const scopedAccounts = accounts
    .filter((a) => keptAccounts.has(str(a.id) ?? ""))
    .map((a) => {
      if (primary.has(str(a.id) ?? "")) return a;
      const copy = { ...a };
      for (const col of [...LINK_COLS, "scheduled_transaction_id"]) {
        if (!inScope(copy[col])) copy[col] = null;
      }
      return copy;
    });

  const scheduled = (tables.scheduled_transactions ?? []).filter((s) =>
    inScope(s.account_id),
  );
  const scheduledIds = new Set(scheduled.map((s) => str(s.id)));
  const scheduledSplits = (tables.scheduled_transaction_splits ?? []).filter(
    (s) => scheduledIds.has(str(s.scheduled_transaction_id)),
  );
  const scheduledSplitIds = new Set(scheduledSplits.map((s) => str(s.id)));

  const out: TableMap = { ...tables };
  out.accounts = scopedAccounts;
  out.transactions = keptTx;
  out.transaction_splits = keptSplits;
  out.transaction_tags = (tables.transaction_tags ?? []).filter((x) =>
    keptTxIds.has(str(x.transaction_id) ?? ""),
  );
  out.transaction_split_tags = (tables.transaction_split_tags ?? []).filter(
    (x) => keptSplitIds.has(str(x.transaction_split_id)),
  );
  out.holdings = (tables.holdings ?? []).filter((h) => inScope(h.account_id));
  out.investment_transactions = (tables.investment_transactions ?? []).filter(
    (t) => inScope(t.account_id),
  );
  out.scheduled_transactions = scheduled;
  out.scheduled_transaction_splits = scheduledSplits;
  out.scheduled_transaction_overrides = (
    tables.scheduled_transaction_overrides ?? []
  ).filter((o) => scheduledIds.has(str(o.scheduled_transaction_id)));
  out.scheduled_transaction_split_tags = (
    tables.scheduled_transaction_split_tags ?? []
  ).filter((x) => scheduledSplitIds.has(str(x.scheduled_transaction_split_id)));
  out.loan_scenarios = (tables.loan_scenarios ?? []).filter((s) =>
    inScope(s.account_id),
  );
  out.loan_rate_changes = (tables.loan_rate_changes ?? []).filter((r) =>
    inScope(r.account_id),
  );
  out.monthly_account_balances = (tables.monthly_account_balances ?? []).filter(
    (m) => inScope(m.account_id),
  );

  // Budget transfer targets pointing at a dropped account would dangle on
  // restore; clear them (budgets themselves are kept whole).
  out.budget_categories = (tables.budget_categories ?? []).map((c) =>
    c.transfer_account_id && !inScope(c.transfer_account_id)
      ? { ...c, transfer_account_id: null }
      : c,
  );

  return out;
}
