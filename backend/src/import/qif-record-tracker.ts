import { parseQifAmount } from "./amount-separators.util";
import type {
  CsvUnreadableAmountRow,
  CsvUnreadableDateRow,
} from "./csv-parser";
import type { QifTransaction } from "./qif-parser";

/** Longest raw amount text an unreadable record carries back. */
const RAW_AMOUNT_LIMIT = 50;

/**
 * What the QIF parsers track for the record being read: the first amount
 * field that cannot be read (the record is then reported, never imported at
 * 0) and the names the record uses, which reach the file's lists only when the
 * record is kept. `parseQif` and `parseQifFull` each hold one.
 */
export class QifRecordTracker {
  /** The first unreadable field of the record; valid once `settleBad` ran. */
  bad: string | null = null;
  /** The line the record starts on, 1-based. */
  startLine = 0;
  categories = new Set<string>();
  transfers = new Set<string>();
  securities = new Set<string>();
  // T and U are one amount written twice: the record is bad only when none of
  // them reads, so a failure is held here until the record ends.
  private amountBad: string | null = null;
  private amountRead = false;

  constructor(
    private readonly parseQuantity: (
      raw: string,
      isSplit: boolean,
    ) => number | null,
    private readonly clean: (value: string, maxLength: number) => string,
  ) {}

  /** Begin a new record starting on `line`. */
  start(line: number): void {
    this.bad = null;
    this.amountBad = null;
    this.amountRead = false;
    this.categories = new Set();
    this.transfers = new Set();
    this.securities = new Set();
    this.startLine = line;
  }

  /**
   * An optional amount field (split, price, commission): its value, or 0 with
   * the record marked unreadable. A blank field stays 0 when `blankIsZero`.
   */
  amountOf(value: string, blankIsZero = false): number {
    if (blankIsZero && value === "") return 0;
    const amount = parseQifAmount(value);
    if (amount !== null) return amount;
    this.bad ??= this.clean(value, RAW_AMOUNT_LIMIT);
    return 0;
  }

  /**
   * A T or U line. A good one sets the record's amount and clears an earlier
   * failure; a failure after a good one is ignored. A blank field on a record
   * where `blankIsZero` (an investment record) is 0.
   */
  setAmount(
    tx: Partial<QifTransaction>,
    value: string,
    blankIsZero: boolean,
  ): void {
    if (blankIsZero && value === "") {
      if (!this.amountRead) tx.amount = 0;
      return;
    }
    const amount = parseQifAmount(value);
    if (amount !== null) {
      tx.amount = amount;
      this.amountRead = true;
      this.amountBad = null;
    } else if (!this.amountRead) {
      this.amountBad ??= this.clean(value, RAW_AMOUNT_LIMIT);
    }
  }

  /** A blank Q reads as 0; a Q with text that is no quantity is reported. */
  quantityOf(raw: string, isSplit = false): number {
    const quantity = this.parseQuantity(raw, isSplit);
    if (quantity !== null) return quantity;
    if (raw !== "") this.bad ??= this.clean(raw, RAW_AMOUNT_LIMIT);
    return 0;
  }

  /** Call at the record's end, before reading `bad`. */
  settleBad(): void {
    this.bad ??= this.amountBad;
  }

  /** Add the record's names to the file's (or block's) lists, if it is kept. */
  keepNames(
    categories: Set<string>,
    transfers: Set<string>,
    securities: Set<string>,
  ): void {
    if (this.bad !== null) return;
    this.categories.forEach((v) => categories.add(v));
    this.transfers.forEach((v) => transfers.add(v));
    this.securities.forEach((v) => securities.add(v));
  }

  /** The report row for the record, which a transfer flags for the importer. */
  unreadableRow(tx: Partial<QifTransaction>): CsvUnreadableAmountRow {
    return {
      rowNumber: this.startLine,
      rawAmount: this.bad ?? "",
      date: tx.date ?? "",
      payee: tx.payee ?? "",
      ...(tx.isTransfer ? { isTransfer: true } : {}),
    };
  }

  /** The report row for a record whose D line holds no readable date. */
  unreadableDateRow(
    tx: Partial<QifTransaction>,
    rawDate: string,
  ): CsvUnreadableDateRow {
    return {
      rowNumber: this.startLine,
      rawDate: this.clean(rawDate, RAW_AMOUNT_LIMIT),
      amount: this.bad === null ? (tx.amount ?? 0) : 0,
      ...(this.bad !== null ? { rawAmount: this.bad } : {}),
      payee: tx.payee ?? "",
      ...(tx.isTransfer ? { isTransfer: true } : {}),
    };
  }
}
