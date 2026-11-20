import type { DashboardTrivia } from "../entities/dashboard-trivia.entity";
import { familyOf, type TriviaFamily } from "./trivia-families";
import { selectDailyTrivia, TRIVIA_DAILY_COUNT } from "./trivia-rotation";
import type { TriviaFact, TriviaFactId, TriviaWindow } from "./trivia.types";

interface FactRef {
  id: TriviaFactId;
  /** Only a calculated item pins the window; a model's names the id alone. */
  window?: TriviaWindow;
  pinned: boolean;
}

/** The facts a stored row shows, in the row's order. */
function refsOf(row: DashboardTrivia): FactRef[] {
  return row.items.flatMap((item): FactRef[] => {
    if (item.source === "calculated") {
      return [{ id: item.factId, window: item.params?.window, pinned: true }];
    }
    return Array.isArray(item.factIds)
      ? item.factIds.map((id) => ({ id, pinned: false }))
      : [];
  });
}

/**
 * Today's choice kept for a rewording: the pool facts the stored row shows,
 * by id and window for a calculated item and by `factIds` for a model's, in
 * the row's order and at most `TRIVIA_DAILY_COUNT` of them (a row from before
 * the rotation can hold more). When facts dropped out (a bill the page's pool
 * does not read, a source that failed) the list is topped up through
 * `selectDailyTrivia`, from families the kept facts do not already cover. A row
 * naming no fact keeps nothing, so the caller selects afresh.
 */
export function keepForRewording(
  row: DashboardTrivia,
  pool: TriviaFact[],
  userId: string,
  today: string,
): TriviaFact[] {
  const refs = refsOf(row);
  const wanted = Math.min(refs.length, TRIVIA_DAILY_COUNT);
  const kept: TriviaFact[] = [];
  for (const ref of refs) {
    if (kept.length >= wanted) break;
    const found = pool.find(
      (fact) =>
        fact.id === ref.id &&
        !kept.includes(fact) &&
        (!ref.pinned || fact.params?.window === ref.window),
    );
    if (found) kept.push(found);
  }
  if (kept.length >= wanted) return kept;

  const covered = new Set<TriviaFamily>(kept.map((fact) => familyOf(fact.id)));
  const extra = selectDailyTrivia(
    pool,
    { families: new Set(covered), figures: {} },
    userId,
    today,
  ).filter((fact) => !covered.has(familyOf(fact.id)));
  return [...kept, ...extra.slice(0, wanted - kept.length)];
}
