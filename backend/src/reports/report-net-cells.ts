import { FxAggregate } from "../common/fx-aggregate";
import { ordinarySplitLines } from "../common/investment-filter.util";
import { isNetSpending } from "../built-in-reports/spending-reports.service";
import { DirectionFilter } from "./entities/custom-report.entity";
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
 * - BOTH reports the magnitude of each category's net, `Math.abs(net)`.
 *
 * Netted within one category, never across two: a group (a month, a payee, a
 * tag) sums its settled cells, so Groceries' refund cannot cancel Rent. A
 * transfer is not netted at all: each transfer line is a cell of its own, so a
 * -200 / +200 pair is two cells judged separately, never one cell of zero.
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
 * still net.
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
  /** The row's currency, which `amount` is in. */
  currency: string;
  /** The split line this is, for a split parent; absent for a whole row. */
  split?: TransactionSplit;
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
      currency: tx.currencyCode,
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
}

/** One cell's parts, by the currency their lines are in. */
type Cell = Map<string, CellPart>;

/** A report's cells for one execution; built per call, never shared. */
export interface NetCells {
  /** Adds one line, already converted (signed), to its cell in `group`. */
  add(group: string, line: NetLine, converted: number | null): void;
  /** Each group's settled sum and count; a group with no kept cell is absent. */
  settle(): Map<string, { agg: FxAggregate; count: number }>;
}

/**
 * @param keepsUnconverted whether a line with no rate still counts (the count
 *   metric); every money figure leaves it out of the sum and the count alike.
 * @param onLeftOut told, once, of each unit whose line converted but which no
 *   part kept, because every part it sits in holds a line with no rate, so the
 *   report counts it among what it left out; a line with no rate was already
 *   counted when it failed to convert.
 */
export function createNetCells(
  direction: DirectionFilter,
  keepsUnconverted: boolean,
  onLeftOut: (currency: string, unit: string) => void = () => undefined,
): NetCells {
  const groups = new Map<string, Map<string, Cell>>();

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
      };
      cell.set(line.currency, part);
    }
    if (converted === null) part.unconverted = true;
    else {
      part.agg.addConverted(converted);
      part.convertedUnits.add(line.unit);
    }
    part.units.add(line.unit);
  };

  const settle = (): Map<string, { agg: FxAggregate; count: number }> => {
    const settled = new Map<string, { agg: FxAggregate; count: number }>();
    // Units a part kept, and the converted units a part left out for want of
    // a rate elsewhere in it: a unit is left out only where no part kept it
    // (a row under two tags may leave one group and stay in the other).
    const keptUnits = new Set<string>();
    const leftOut = new Map<string, string>();
    for (const [group, cells] of groups) {
      const agg = new FxAggregate();
      const units = new Set<string>();
      let kept = false;
      for (const cell of cells.values()) {
        // The count metric keeps every line; a money figure keeps only the
        // parts whose every line converted.
        const parts = [...cell.entries()].flatMap(([currency, part]) => {
          if (keepsUnconverted || !part.unconverted) {
            for (const unit of part.units) keptUnits.add(unit);
            return [part];
          }
          for (const unit of part.convertedUnits) leftOut.set(unit, currency);
          return [];
        });
        if (parts.length === 0) continue;
        const sum = new FxAggregate();
        for (const part of parts) sum.merge(part.agg);
        const net = sum.knownSubtotal;
        let value: number;
        if (direction === DirectionFilter.EXPENSES_ONLY) {
          value = -net;
          if (!isNetSpending(value)) continue;
        } else if (direction === DirectionFilter.INCOME_ONLY) {
          value = net;
          if (!(value > 0)) continue;
        } else {
          value = Math.abs(net);
        }
        kept = true;
        agg.addConverted(value);
        for (const part of parts) {
          for (const unit of part.units) units.add(unit);
        }
      }
      if (kept) settled.set(group, { agg, count: units.size });
    }
    for (const [unit, currency] of leftOut) {
      if (!keptUnits.has(unit)) onLeftOut(currency, unit);
    }
    return settled;
  };

  return { add, settle };
}
