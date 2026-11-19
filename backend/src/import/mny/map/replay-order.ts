import { MappedInvestmentTransaction } from "../model/mny-import-model";
import { MnyTransaction } from "../model/mny-rows";
import { sortableRowIds } from "./sortable-row-ids";

/**
 * The order an import's investment rows replay in, before and after the write
 * (S1), shared by the Money and KMyMoney mappers.
 */

/** The ids one `TRN` row's investment rows take: the row's, and its INTEREST companion's. */
export interface JournalIds {
  readonly id: string;
  readonly companionId: string;
}

/**
 * Replay order: by date, then by row id. The holdings rebuild folds the written
 * rows in `INVESTMENT_REPLAY_ORDER` (date, `created_at`, id), and every row one
 * import writes shares its `created_at`, so within a date the database orders
 * them by id -- not by insertion, which no `ORDER BY` sees. Sorting by the same
 * pair makes this the order the positions will be folded in after the write.
 * The ids are `sortableRowIds`, handed out in the source's journal order
 * (`moneyJournalIds` for Money, KMyMoney's journal order in `kmy-map-investments.ts`), so
 * that order is the source's own (S1).
 */
export function orderForReplay(
  transactions: readonly MappedInvestmentTransaction[],
): MappedInvestmentTransaction[] {
  return [...transactions].sort((a, b) =>
    a.transactionDate !== b.transactionDate
      ? a.transactionDate < b.transactionDate
        ? -1
        : 1
      : a.id < b.id
        ? -1
        : a.id > b.id
          ? 1
          : 0,
  );
}

/**
 * The ids of every investment `TRN` row, handed out in Money's journal order:
 * date, then `htrn` (S1). `htrn` is the row's own identifier and the only
 * per-row sequence the file stores. The reader returns rows in physical order,
 * which is storage layout and does not follow it: the committed
 * `sample-money99-investments.mny` reads three rows out of `htrn` order, one of
 * them inside a same-day group of one security. Each
 * row reserves a second id for an INTEREST companion, next after its own, so a
 * companion replays right after its redemption.
 */
export function moneyJournalIds(
  rows: readonly MnyTransaction[],
): Map<number, JournalIds> {
  const next = sortableRowIds();
  const ordered = rows
    .filter(
      (row): row is MnyTransaction & { handle: number; date: string } =>
        row.handle !== null && row.date !== null && row.security !== null,
    )
    .sort((a, b) =>
      a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.handle - b.handle,
    );
  const ids = new Map<number, JournalIds>();
  for (const row of ordered) {
    ids.set(row.handle, { id: next(), companionId: next() });
  }
  return ids;
}
