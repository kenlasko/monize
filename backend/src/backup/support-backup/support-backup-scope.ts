export type TableMap = Record<string, Record<string, unknown>[]>;

const str = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** Normalizes a DATE column value (string or Date) to its yyyy-MM-dd key. */
const dateKey = (value: unknown): string | null => {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "string" && value.length >= 10)
    return value.slice(0, 10);
  return null;
};

/**
 * Rows the app never applies to an account balance: VOID transactions and
 * legacy split-child rows (children carry parent_transaction_id; the parent
 * already accounts for their amounts). Shared by the date-range opening
 * adjustment here and the balance reconciliation in the service.
 */
export function countsTowardBalance(tx: Record<string, unknown>): boolean {
  return tx.status !== "VOID" && !tx.parent_transaction_id;
}

/**
 * Trims the export to transactions dated within [from, to]. Cutting history
 * would silently break the balance reconciliation (opening + kept transactions
 * no longer equals the balance), so each account's opening_balance is advanced
 * by the sum of its removed pre-`from` transactions first -- the trimmed file
 * then reconciles to the true balance as of `to`. Date-bounded satellite
 * tables (investment transactions, monthly balances, price history) are
 * trimmed to the same window; any references this severs are repaired by the
 * dangling-reference scrub that runs after scoping.
 */
export function applyDateRange(
  tables: TableMap,
  from?: string,
  to?: string,
): TableMap {
  if (!from && !to) return tables;
  const within = (value: unknown): boolean => {
    const key = dateKey(value);
    if (key === null) return true;
    if (from && key < from) return false;
    if (to && key > to) return false;
    return true;
  };

  const out: TableMap = { ...tables };

  if (from) {
    const openingShift = new Map<string, number>();
    for (const tx of tables.transactions ?? []) {
      const key = dateKey(tx.transaction_date);
      if (key === null || key >= from || !countsTowardBalance(tx)) continue;
      const amount = Number(tx.amount);
      if (!Number.isFinite(amount)) continue;
      const account = String(tx.account_id);
      openingShift.set(
        account,
        (openingShift.get(account) ?? 0) + Math.round(amount * 10000),
      );
    }
    out.accounts = (tables.accounts ?? []).map((account) => {
      const shift = openingShift.get(String(account.id));
      if (!shift) return account;
      const opening = Number(account.opening_balance) || 0;
      return {
        ...account,
        opening_balance: (Math.round(opening * 10000) + shift) / 10000,
      };
    });
  }

  out.transactions = (tables.transactions ?? []).filter((t) =>
    within(t.transaction_date),
  );
  out.investment_transactions = (tables.investment_transactions ?? []).filter(
    (t) => within(t.transaction_date),
  );
  out.monthly_account_balances = (tables.monthly_account_balances ?? []).filter(
    (m) => within(m.month),
  );
  out.security_prices = (tables.security_prices ?? []).filter((p) =>
    within(p.price_date),
  );
  return out;
}

/**
 * Narrows the export to a chosen set of accounts and their referential
 * closure, so a user can share only the account a bug concerns.
 *
 * Dimension tables that are not account-specific -- categories, payees,
 * payee_aliases, tags, institutions, securities, security_prices, currencies,
 * budgets and reports -- are kept whole. Their content is already masked and
 * keeping them intact avoids dangling FKs; the scope's purpose is to cut the
 * volume and range of transactional data. Anything this trimming severs
 * (scheduled transfer targets, cross-account investment links, out-of-scope
 * link columns) is repaired afterwards by scrubDanglingRefs, which nulls or
 * drops every reference whose target is absent from the file.
 */
export function scopeToAccounts(
  tables: TableMap,
  accountIds: string[],
): TableMap {
  const accounts = tables.accounts ?? [];
  const byId = new Map(accounts.map((a) => [str(a.id), a] as const));

  // Primary accounts: the selection plus every account transitively reachable
  // through the hard account-to-account links (cash<->brokerage pairs, loan
  // payment source, loan<->asset links) -- walked to a fixed point so a
  // second-hop link cannot dangle.
  const LINK_COLS = [
    "linked_account_id",
    "linked_loan_account_id",
    "source_account_id",
  ];
  const primary = new Set<string>();
  const queue = [...accountIds];
  while (queue.length > 0) {
    const id = queue.pop()!;
    if (primary.has(id)) continue;
    const account = byId.get(id);
    if (!account) continue;
    primary.add(id);
    for (const col of LINK_COLS) {
      const ref = str(account[col]);
      if (ref && byId.has(ref) && !primary.has(ref)) queue.push(ref);
    }
  }

  // Transactions on primary accounts, plus every leg they reference: transfer
  // and split-parent links on the transaction itself AND the mirror
  // transactions that split-transfer rows point at (the forward link of a
  // split-based transfer lives on the split, not the parent transaction).
  const allTx = tables.transactions ?? [];
  const txById = new Map(allTx.map((t) => [str(t.id), t] as const));
  const splitsByTx = new Map<string, Record<string, unknown>[]>();
  for (const split of tables.transaction_splits ?? []) {
    const txId = str(split.transaction_id);
    if (!txId) continue;
    const list = splitsByTx.get(txId);
    if (list) list.push(split);
    else splitsByTx.set(txId, [split]);
  }

  const keptTxIds = new Set<string>();
  const stack: Record<string, unknown>[] = [];
  const pushTx = (id: string | null) => {
    if (id && !keptTxIds.has(id) && txById.has(id)) {
      keptTxIds.add(id);
      stack.push(txById.get(id)!);
    }
  };
  for (const t of allTx) {
    if (primary.has(str(t.account_id) ?? "")) pushTx(str(t.id));
  }
  while (stack.length > 0) {
    const t = stack.pop()!;
    pushTx(str(t.linked_transaction_id));
    pushTx(str(t.parent_transaction_id));
    for (const split of splitsByTx.get(str(t.id) ?? "") ?? []) {
      pushTx(str(split.linked_transaction_id));
    }
  }
  const keptTx = allTx.filter((t) => keptTxIds.has(str(t.id) ?? ""));

  const keptSplits = (tables.transaction_splits ?? []).filter((s) =>
    keptTxIds.has(str(s.transaction_id) ?? ""),
  );
  const keptSplitIds = new Set(keptSplits.map((s) => str(s.id)));

  // Shell accounts: counterparties referenced by the kept rows that aren't
  // primary. Their own transactions are NOT pulled in.
  const shell = new Set<string>();
  const noteAccount = (ref: string | null) => {
    if (ref && !primary.has(ref) && byId.has(ref)) shell.add(ref);
  };
  for (const t of keptTx) noteAccount(str(t.account_id));
  for (const s of keptSplits) noteAccount(str(s.transfer_account_id));

  const keptAccounts = new Set<string>([...primary, ...shell]);
  const inScope = (ref: unknown) => keptAccounts.has(str(ref) ?? "");

  const scopedAccounts = accounts.filter((a) =>
    keptAccounts.has(str(a.id) ?? ""),
  );

  const scheduled = (tables.scheduled_transactions ?? []).filter((s) =>
    inScope(s.account_id),
  );
  const scheduledIds = new Set(scheduled.map((s) => str(s.id)));
  const scheduledSplits = (tables.scheduled_transaction_splits ?? []).filter(
    (s) => scheduledIds.has(str(s.scheduled_transaction_id)),
  );

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
  const scheduledSplitIds = new Set(scheduledSplits.map((s) => str(s.id)));
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

  // Per-widget dashboard settings embed account ids in a free-form JSONB
  // shape; with excluded accounts in play the safe move is a reset (their
  // ids would otherwise leak un-remapped, and the shape is too loose to
  // filter selectively).
  out.user_preferences = (tables.user_preferences ?? []).map((prefs) =>
    "dashboard_widget_config" in prefs
      ? { ...prefs, dashboard_widget_config: {} }
      : prefs,
  );

  return out;
}
