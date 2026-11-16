import type { DuplicateConfidence, DuplicateGroup } from '@/types/built-in-reports';

/** Strongest first: the order the report lists groups and offers selection. */
export const DUPLICATE_CONFIDENCE_LEVELS: readonly DuplicateConfidence[] = [
  'very_high',
  'high',
  'medium',
  'low',
];

const KEEP_PRIORITY: Readonly<Record<string, number>> = {
  RECONCILED: 0,
  CLEARED: 1,
};

/**
 * The member of a group that "select duplicates" leaves unselected: a
 * reconciled row first (deleting it would unbalance a statement, and the
 * reconciled lock refuses it), then a cleared one, then the earliest, which is
 * the first in the group since the server lists members by date.
 */
export function keeperId(group: DuplicateGroup): string {
  let keeper = group.transactions[0];
  for (const tx of group.transactions) {
    const rank = KEEP_PRIORITY[tx.status ?? ''] ?? 2;
    const keeperRank = KEEP_PRIORITY[keeper.status ?? ''] ?? 2;
    if (rank < keeperRank) keeper = tx;
  }
  return keeper.id;
}

/**
 * What "select duplicates" ticks in a group: every member except the one it
 * keeps, so each group is left with exactly one copy. A reconciled copy is
 * ticked like any other, since history imported from Money arrives reconciled
 * and its duplicates are reconciled on both sides. Only while the strict
 * reconciled lock is on is a reconciled copy left for the user to tick by
 * hand: the server refuses to delete it then, and one refused row refuses the
 * whole bulk delete, so ticking it for them would stop every other group's
 * copies from being removed too.
 */
export function extraCopyIds(group: DuplicateGroup, reconciledLocked: boolean): string[] {
  const keep = keeperId(group);
  return group.transactions
    .filter((tx) => tx.id !== keep && !(reconciledLocked && tx.status === 'RECONCILED'))
    .map((tx) => tx.id);
}

/**
 * `selected` plus the extra copies of every group at `level`. Returns a new
 * set; the caller's is never mutated.
 */
export function withDuplicatesAt(
  groups: readonly DuplicateGroup[],
  level: DuplicateConfidence,
  selected: ReadonlySet<string>,
  reconciledLocked: boolean,
): Set<string> {
  const next = new Set(selected);
  for (const group of groups) {
    if (group.confidence !== level) continue;
    for (const id of extraCopyIds(group, reconciledLocked)) next.add(id);
  }
  return next;
}

/**
 * The selected ids that are still on screen. A selection outlives the answer
 * it was made against (a new range, a reload after a delete), and a row that
 * is no longer listed must never be deleted by a click on what is.
 */
export function selectionInGroups(
  groups: readonly DuplicateGroup[],
  selected: ReadonlySet<string>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const tx of group.transactions) {
      if (selected.has(tx.id) && !seen.has(tx.id)) {
        seen.add(tx.id);
        ids.push(tx.id);
      }
    }
  }
  return ids;
}

/** How many groups would lose every copy, the original included. */
export function groupsFullySelected(
  groups: readonly DuplicateGroup[],
  selected: ReadonlySet<string>,
): number {
  return groups.filter((group) => group.transactions.every((tx) => selected.has(tx.id))).length;
}
