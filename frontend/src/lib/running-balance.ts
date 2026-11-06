import type { SortDirection } from '@/hooks/useSortableTable';
import { TransactionStatus } from '@/types/transaction';
import { FIAT_MONEY_DECIMALS, fromMoneyUnits, toMoneyUnits } from '@/lib/format';

/** What the walk needs of a row; typed structurally so a test fixture is honest. */
export interface RunningBalanceRow {
  id: string;
  amount: number | string;
  status?: TransactionStatus | null;
  parentTransactionId?: string | null;
}

/**
 * Whether the row moved the account's balance.
 *
 * A VOID row records something that did not happen and a split child is not a
 * movement -- its parent already carries the total. Both still occupy a line
 * in the register, so they take a balance from the row above rather than
 * being skipped.
 */
export function rowAffectsBalance(row: RunningBalanceRow): boolean {
  return row.status !== TransactionStatus.VOID && !row.parentTransactionId;
}

/**
 * The balance to print beside each row of one page.
 *
 * The server sends one number: `startingBalance`, the balance **after the
 * newest row on this page**. The walk runs from there, newest row first,
 * subtracting each row as it goes -- so an oldest-first page is reversed
 * before it is walked, which is the whole of what sorting ascending changes
 * here. The result is keyed by id, so the caller renders in whatever order it
 * received.
 *
 * Money accumulates in integers (`AGENTS.md`): summing fifty floats down a
 * page drifts a cent, and a register is exactly where a reader would notice.
 * The integers are units of `decimals`, the account currency's money
 * precision (`moneyDecimalsForCurrency(code)`: four for fiat, a coin's eight),
 * held in `BigInt` so eight places stay exact above 2^53 units.
 *
 * An absent or unusable seed returns an empty map rather than zeroes: no
 * balance is not a balance of nothing, and the cell renders as unknown.
 */
export function walkRunningBalances(
  rows: readonly RunningBalanceRow[],
  startingBalance: number | undefined,
  direction: SortDirection,
  displayAmounts?: ReadonlyMap<string, number>,
  decimals: number = FIAT_MONEY_DECIMALS,
): Map<string, number> {
  const balances = new Map<string, number>();
  const seed = Number(startingBalance);
  if (startingBalance === undefined || !Number.isFinite(seed) || rows.length === 0) {
    return balances;
  }

  const newestFirst = direction === 'asc' ? [...rows].reverse() : rows;
  const seedUnits = toMoneyUnits(seed, decimals);
  let cumulativeUnits = BigInt(0);

  for (const row of newestFirst) {
    balances.set(row.id, fromMoneyUnits(seedUnits - cumulativeUnits, decimals));
    if (rowAffectsBalance(row)) {
      const raw = displayAmounts?.get(row.id) ?? Number(row.amount);
      if (Number.isFinite(raw)) cumulativeUnits += toMoneyUnits(raw, decimals);
    }
  }

  return balances;
}
