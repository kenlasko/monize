import { FxAggregate } from "../common/fx-aggregate";
import { ordinarySplitLines } from "../common/investment-filter.util";
import { isNetSpending } from "../built-in-reports/spending-reports.service";
import {
  DirectionFilter,
  MetricType,
  type ReportConfig,
} from "./entities/custom-report.entity";
import { Transaction } from "../transactions/entities/transaction.entity";
import { TransactionSplit } from "../transactions/entities/transaction-split.entity";

/**
 * What a custom report's category costs, settled the way Spending by Category
 * settles it (audit A26-M33, `isNetSpending` / `NET_SPEND_AMOUNT` in
 * `built-in-reports/spending-reports.service.ts`).
 *
 * Every line of every row is added, SIGNED, to a cell: one (group, category)
 * pair. A category's cost is its debits net of its credits, so a -100 expense
 * and a +30 refund in Groceries are one cell of -70, and the direction is
 * judged on that net afterwards, never row by row:
 *
 * - EXPENSES_ONLY reports `-net` for a cell that is net spending
 *   (`isNetSpending`), so a refund lowers the cost and an income category is
 *   not a row;
 * - INCOME_ONLY reports `net` for a cell that is positive;
 * - BOTH / TOTAL_AMOUNT keeps the signed net. For other grouped BOTH metrics
 *   the magnitude of each category's net remains their calculation basis.
 *
 * Each group (a month, a payee, a tag) sums its settled cells. Each transfer
 * leg is its own cell. Both in-scope legs of a consistently valued transfer
 * cancel in a signed total and are judged separately for one-direction reports.
 *
 * A cell also remembers which "units" fed it, so a group's count is the number
 * of distinct units across its kept cells: a transaction counts once per group
 * (a line once per category, when grouped by category).
 *
 * A money figure leaves a cell's currency part out whole when any of its lines
 * has no rate (issue #2130), the rule the built-in reports apply through
 * `wholeGroups` to their (group, category, currency) aggregates: keeping the
 * lines that converted would report a category whose debit is in and whose
 * refund, struck on a day with no rate, is out. The cell's other currencies
 * still net. Signed totals apply that eligibility to the whole report before
 * grouping, so regrouping cannot change the known part of a partial total.
 *
 * A provisional transfer leg (`amountIsProvisional`, an amount the importer
 * estimated) is in a figure exactly when its line converted and its part and
 * cell were kept; `settle` names each such row once, so the report can say how
 * many estimates its figures hold (`docs/specs/provisional-amounts.md`
 * section 6, P5).
 */

/** One line of a row, before conversion. */
export interface NetLine {
  /** The category the line nets in; unique per line for a transfer. */
  cell: string;
  /** The line's category key, `"uncategorized"` when it has none. */
  category: string;
  /** Signed, in the row's own currency. */
  amount: number;
  /** What a group counts: the row, or the line when grouped by category. */
  unit: string;
  /** Posting identity, independent of how its group counts a split parent. */
  component: string;
  /** The row's currency, which `amount` is in. */
  currency: string;
  /** The split line this is, for a split parent; absent for a whole row. */
  split?: TransactionSplit;
  /**
   * The row's id when its amount is provisional. Only a whole row can be: a
   * split line never is (its counterpart is a whole row and carries the flag).
   */
  provisionalRow?: string;
}

/**
 * The lines of a row. A split parent with hydrated lines is its ordinary lines
 * (an embedded investment line is the trade's own cash side); a parent whose
 * lines were not hydrated, or any other row, is the row itself. A parent whose
 * hydrated ordinary lines are empty represents no cash and has no line.
 * `perLine` is the category grouping, which counts lines rather than rows.
 */
export function netLinesOf(tx: Transaction, perLine: boolean): NetLine[] {
  const unitOf = (index: number) => (perLine ? `${tx.id}:${index}` : tx.id);

  if (tx.isSplit && tx.splits) {
    return ordinarySplitLines(tx).map((split, index) => {
      const category = split.categoryId || "uncategorized";
      return {
        cell:
          split.transferAccountId != null
            ? `transfer:${tx.id}:${index}`
            : category,
        category,
        amount: Number(split.amount),
        unit: unitOf(index),
        component: `${tx.id}:${index}`,
        currency: tx.currencyCode,
        split,
      };
    });
  }

  const category = tx.categoryId || "uncategorized";
  return [
    {
      cell: tx.isTransfer ? `transfer:${tx.id}:0` : category,
      category,
      amount: Number(tx.amount),
      unit: unitOf(0),
      component: tx.id,
      currency: tx.currencyCode,
      ...(tx.amountIsProvisional === true ? { provisionalRow: tx.id } : {}),
    },
  ];
}

/** The lines of one currency in a cell. */
interface CellPart {
  agg: FxAggregate;
  units: Set<string>;
  /** The units of the lines that converted. */
  convertedUnits: Set<string>;
  /** A line of this part had no rate. */
  unconverted: boolean;
  /** The provisional rows whose lines converted into `agg`. */
  provisionalRows: Set<string>;
}

/** One cell's parts, by the currency their lines are in. */
type Cell = Map<string, CellPart>;

export interface NetGroup {
  agg: FxAggregate;
  count: number;
}

export function isSignedTotal(
  direction: DirectionFilter,
  metric: MetricType,
): boolean {
  return (
    direction !== DirectionFilter.EXPENSES_ONLY &&
    direction !== DirectionFilter.INCOME_ONLY &&
    metric === MetricType.TOTAL_AMOUNT
  );
}

/** A signed net is not a parts-of-a-whole measure, just as on a BOTH transaction list. */
export function shareDenominator(
  groups: ReadonlyMap<string, NetGroup>,
  config: ReportConfig,
): FxAggregate | undefined {
  if (isSignedTotal(config.direction, config.metric)) return undefined;
  return FxAggregate.sum(Array.from(groups.values(), (group) => group.agg));
}

/** A report's cells for one execution; built per call, never shared. */
export interface NetCells {
  /** Adds one line, already converted (signed), to its cell in `group`. */
  add(group: string, line: NetLine, converted: number | null): void;
  /** Each group's settled sum and count; a group with no kept cell is absent. */
  settle(): Map<string, NetGroup>;
}

/**
 * @param metric determines whether cells contribute their signed value or a
 *   magnitude and whether a line with no rate still counts (the count metric).
 * @param onLeftOut told, once, of each unit whose line converted but which no
 *   part kept, because every part it sits in holds a line with no rate, so the
 *   report counts it among what it left out; a line with no rate was already
 *   counted when it failed to convert.
 * @param onProvisional told, once per settle, of each provisional row whose
 *   converted amount is inside a kept group's sum.
 */
export function createNetCells(
  direction: DirectionFilter,
  metric: MetricType,
  onLeftOut: (currency: string, unit: string) => void = () => undefined,
  onProvisional: (row: string) => void = () => undefined,
): NetCells {
  const groups = new Map<string, Map<string, Cell>>();
  const signedTotal = isSignedTotal(direction, metric);
  // Each category/currency has one eligibility decision for the signed total.
  const incompleteCells = new Map<string, Set<string>>();

  const add = (
    group: string,
    line: NetLine,
    converted: number | null,
  ): void => {
    let cells = groups.get(group);
    if (!cells) {
      cells = new Map();
      groups.set(group, cells);
    }
    let cell = cells.get(line.cell);
    if (!cell) {
      cell = new Map();
      cells.set(line.cell, cell);
    }
    let part = cell.get(line.currency);
    if (!part) {
      part = {
        agg: new FxAggregate(),
        units: new Set(),
        convertedUnits: new Set(),
        unconverted: false,
        provisionalRows: new Set(),
      };
      cell.set(line.currency, part);
    }
    if (converted === null) {
      part.unconverted = true;
      if (signedTotal) {
        const missing = incompleteCells.get(line.currency) ?? new Set<string>();
        missing.add(line.cell);
        incompleteCells.set(line.currency, missing);
      }
    } else {
      part.agg.addConverted(converted);
      part.convertedUnits.add(signedTotal ? line.component : line.unit);
      if (line.provisionalRow !== undefined) {
        part.provisionalRows.add(line.provisionalRow);
      }
    }
    part.units.add(line.unit);
  };

  const settle = (): Map<string, NetGroup> => {
    const settled = new Map<string, NetGroup>();
    // Units a part kept, and the converted units a part left out for want of
    // a rate elsewhere in it: a unit is left out only where no part kept it
    // (a row under two tags may leave one group and stay in the other).
    const keptUnits = new Set<string>();
    const leftOut = new Map<string, string>();
    // A provisional row in a sum, once however many groups hold it.
    const provisional = new Set<string>();
    for (const [group, cells] of groups) {
      const agg = new FxAggregate();
      const units = new Set<string>();
      let kept = false;
      for (const [cellKey, cell] of cells) {
        // The count metric keeps every line; a money figure keeps only the
        // parts whose every line converted.
        const parts = [...cell.entries()].flatMap(([currency, part]) => {
          const incomplete =
            part.unconverted || incompleteCells.get(currency)?.has(cellKey);
          if (metric === MetricType.COUNT || !incomplete) {
            for (const unit of part.units) keptUnits.add(unit);
            return [part];
          }
          for (const unit of part.convertedUnits) leftOut.set(unit, currency);
          return [];
        });
        if (parts.length === 0) continue;
        const net = new FxAggregate();
        for (const part of parts) net.merge(part.agg);
        // Judged on the net's sign before rounding, and folded into the group
        // unrounded: reading the cell at four places first made the group's
        // sum depend on how its rows fell into cells, so two 124.752474 cells
        // summed to 249.5050 where one cell of both read 249.5049
        // (docs/specs/report-rounding-and-aggregation.md rules 2 and 5).
        let spent: boolean;
        if (direction === DirectionFilter.EXPENSES_ONLY) {
          if (!isNetSpending(-net.sign)) continue;
          spent = true;
        } else if (direction === DirectionFilter.INCOME_ONLY) {
          if (!(net.sign > 0)) continue;
          spent = false;
        } else {
          spent = !signedTotal && net.sign < 0;
        }
        kept = true;
        if (spent) agg.mergeNegated(net);
        else agg.merge(net);
        for (const part of parts) {
          for (const unit of part.units) units.add(unit);
          for (const row of part.provisionalRows) provisional.add(row);
        }
      }
      if (kept) settled.set(group, { agg, count: units.size });
    }
    for (const [unit, currency] of leftOut) {
      if (signedTotal || !keptUnits.has(unit)) onLeftOut(currency, unit);
    }
    for (const row of provisional) onProvisional(row);
    return settled;
  };

  return { add, settle };
}
