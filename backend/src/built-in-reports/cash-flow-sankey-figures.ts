/**
 * The Cash Flow Sankey's figures, each rounded once from its own components
 * (`docs/specs/report-rounding-and-aggregation.md` rule 6): each side's total
 * is the single rounding of everything on that side and the nodes on it are
 * apportioned from it; a depth-2 parent's children and a class's accounts are
 * apportioned from their parent. So every pass-through node closes in the
 * reporting currency's minor unit (SANKEY-001; cents for USD, whole yen for
 * JPY, section 6), and no total is a sum of separately rounded parts, which
 * read two 124.752474 children as 249.5050 under a 249.5049 parent and
 * answered a 500.
 *
 * Apportioning a whole side is a recorded choice with a cost: a category node
 * can read one unit, a cent, off the same category rounded on its own, as
 * Spending by Category rounds it. The page says so beside the node.
 */
import { isIncomeCategory } from "../categories/category-type.util";
import { FxAggregate } from "../common/fx-aggregate";
import type { SankeyNodeKind } from "./dto/cash-flow-sankey.dto";

/**
 * `parts`' figures in units of `10^-places`, apportioned so they sum to
 * `target` (by default their merged reading) through
 * `FxAggregate.apportionUnits`. A tie between remainders goes to the lower
 * key, so the answer does not depend on the order the rows arrived in.
 */
export function apportionByKey(
  parts: ReadonlyArray<[string, FxAggregate]>,
  places: number,
  target?: number,
): Map<string, number> {
  const ordered = [...parts].sort(([a], [b]) => a.localeCompare(b));
  const units = FxAggregate.apportionUnits(
    ordered.map(([, agg]) => agg),
    places,
    target,
  );
  return new Map(ordered.map(([key], index) => [key, units[index]]));
}

/** A top-level category placed on the side it nets to. */
export interface PlacedRoot<C> {
  rootId: string;
  category: C;
  complete: boolean;
  isIncomeSide: boolean;
  id: string;
  kind: SankeyNodeKind;
  /** The net in the side's direction: what came in, or what was spent. */
  oriented: FxAggregate;
}

/**
 * Each top-level category on its side. A complete category sits where it nets
 * (the isNetSpending rule, both ways), judged on the sign before rounding
 * (rule 5); one whose net is unknown sits where its own type says, since the
 * sign that would move it is the figure that is missing.
 */
export function placeRoots<C extends { isIncome: boolean }>(
  roots: ReadonlyMap<string, { agg: FxAggregate }>,
  byId: ReadonlyMap<string, C>,
): PlacedRoot<C>[] {
  return [...roots.entries()].map(([rootId, bucket]) => {
    const category = byId.get(rootId)!;
    const complete = bucket.agg.isComplete;
    const sign = bucket.agg.sign;
    const isIncomeSide = complete
      ? sign > 0 || (sign === 0 && isIncomeCategory(category))
      : isIncomeCategory(category);
    const kind: SankeyNodeKind = isIncomeSide ? "income" : "expense";
    const oriented = isIncomeSide
      ? FxAggregate.sum([bucket.agg])
      : FxAggregate.difference(new FxAggregate(), bucket.agg);
    return {
      rootId,
      category,
      complete,
      isIncomeSide,
      id: `${kind}:${rootId}`,
      kind,
      oriented,
    };
  });
}

/**
 * Each side-level node's figure in units of `10^-places`, keyed by node id:
 * the category roots and the uncategorized nodes of each side, the inflow
 * classes and the outflow classes, every side apportioned from its own single
 * rounding.
 */
export function sideFigures<C>(
  places: number,
  roots: readonly PlacedRoot<C>[],
  uncategorized: ReadonlyArray<[FxAggregate, "income" | "expense"]>,
  inflows: ReadonlyArray<[string, FxAggregate]>,
  outflows: ReadonlyArray<[string, FxAggregate]>,
): Map<string, number> {
  const figures = new Map<string, number>();
  const apportionSide = (parts: ReadonlyArray<[string, FxAggregate]>) => {
    for (const [id, units] of apportionByKey(parts, places)) {
      figures.set(id, units);
    }
  };
  for (const side of ["income", "expense"] as const) {
    apportionSide([
      ...roots
        .filter((root) => root.isIncomeSide === (side === "income"))
        .map((root): [string, FxAggregate] => [root.id, root.oriented]),
      ...uncategorized
        .filter(([, which]) => which === side)
        .map(([agg]): [string, FxAggregate] => [`uncategorized:${side}`, agg]),
    ]);
  }
  apportionSide(inflows);
  apportionSide(outflows);
  return figures;
}
