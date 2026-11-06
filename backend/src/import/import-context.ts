import { BadRequestException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { Account } from "../accounts/entities/account.entity";
import { applyAccountBalanceDelta } from "../accounts/accounts.service";
import { assertAmountPrecision } from "../common/amount-precision.util";
import {
  loadCurrencyPlaces,
  moneyDecimalsForCode,
} from "../common/currency-places.util";
import {
  FIAT_MONEY_DECIMALS,
  moneyDecimalsFor,
  roundMoney,
} from "../common/round.util";
import { returnedRows } from "../common/db/query-result";
import { tr } from "../i18n/translate";
import { TransactionRule } from "../transaction-rules/transaction-rule.entity";
import {
  ImportResultDto,
  ImportSkipReason,
  SKIPPED_ROWS_LIMIT,
} from "./dto/import.dto";
import type { HeldBankRow } from "./ofx-external-id";
import {
  BondProgramCache,
  inferSeriesForDate,
  infersSeriesFromDate,
  programOfSecurity,
  resolveImportedSeries,
  seriesRoleOf,
} from "../bonds/bond-series-resolver";
import {
  BondWriteGuard,
  createBondWriteGuard,
} from "../bonds/bond-write-guard";

/**
 * What an import run remembers about program-linked securities
 * (`docs/specs/bond-program-securities.md` 2.3): the program of each security
 * (looked up once per run, not per row) and the write guard that refuses an
 * import after which a removal is not covered by the lots.
 */
export interface ImportBondState {
  readonly programCache: BondProgramCache;
  readonly guard: BondWriteGuard;
  /** The run's `inferSeriesForDate` answers, see `resolveImportedSeriesMemo`. */
  readonly seriesMemo: ImportSeriesMemo;
}

/**
 * Per-run memo of the series on sale on a date, keyed `programId|YYYY-MM-DD`;
 * null is a remembered "none or more than one on sale" (also never a guess).
 * A file holds thousands of rows on far fewer dates, and the answer cannot
 * change inside the import's transaction (no series is written by it).
 */
export type ImportSeriesMemo = Map<string, string | null>;

/**
 * `resolveImportedSeries` with the date inference memoized for the run: the
 * resolver itself infers once per row, so the memo wraps the call. A row that
 * infers nothing (no program, not a BUY/REINVEST acquisition) takes the
 * resolver's own path unchanged.
 */
export async function resolveImportedSeriesMemo(
  m: EntityManager,
  userId: string,
  row: Parameters<typeof resolveImportedSeries>[2],
  state: Pick<ImportBondState, "programCache" | "seriesMemo">,
): Promise<{ id: string | null; unresolved: boolean }> {
  const program = row.securityId
    ? await programOfSecurity(m, userId, row.securityId, state.programCache)
    : null;
  if (
    program === null ||
    seriesRoleOf(row.action, row.pairedTransfer ?? false) !== "acquisition" ||
    !infersSeriesFromDate(row.action)
  ) {
    return resolveImportedSeries(m, userId, row, state.programCache);
  }
  const date = String(row.transactionDate).slice(0, 10);
  const key = `${program.id}|${date}`;
  let id = state.seriesMemo.get(key);
  if (id === undefined) {
    id = await inferSeriesForDate(m, program.id, date);
    state.seriesMemo.set(key, id);
  }
  return { id, unresolved: id === null };
}

export interface ImportContext {
  manager: EntityManager;
  userId: string;
  accountId: string;
  account: Account;
  /**
   * The money precision of `account`'s currency (`moneyDecimalsFor` of its
   * `decimal_places`), loaded once per file by the import service. Absent
   * reads as the fiat default; read it through `importMoneyDecimals`.
   */
  moneyDecimals?: number;
  /** `currencyMoneyDecimals`' memo: money precision by currency code. */
  decimalsByCode?: Map<string, number>;
  categoryMap: Map<string, string | null>;
  accountMap: Map<string, string | null>;
  loanCategoryMap: Map<string, string>;
  securityMap: Map<string, string | null>;
  /** Maps tag name (case-insensitive key) to tag ID */
  tagMap: Map<string, string>;
  importStartTime: Date;
  dateCounters: Map<string, number>;
  affectedAccountIds: Set<string>;
  /**
   * The scheduled payments a `settle_loan_installment` rule claimed an
   * occurrence of; the import's post-processing reprices each template after
   * the commit (INV-CACHE-001).
   */
  settledScheduleIds: Set<string>;
  importResult: ImportResultDto;
  /** Tracks how many QIF entries with each transfer signature have been seen in the current block,
   *  used to distinguish genuinely different transfers that share date/amount/account. */
  transferDupCounts: Map<string, number>;
  /**
   * The account's rows holding a bank id the file carries (`loadHeldExternalIds`),
   * read once before the first row and kept current as rows take a key. Empty
   * for a file with no bank ids.
   */
  heldExternalIds: Map<string, HeldBankRow>;
  /**
   * The user's enabled rules with trigger "import", loaded once per file by
   * the import service (design 6.3). Absent or empty means no rule runs.
   */
  importRules?: readonly TransactionRule[];
  /** Created by the investment processor on its first row (see `ImportBondState`). */
  bond?: ImportBondState;
}

/** The money precision of the account the import writes to (fiat: 4). */
export function importMoneyDecimals(
  ctx: Pick<ImportContext, "moneyDecimals">,
): number {
  return ctx.moneyDecimals ?? FIAT_MONEY_DECIMALS;
}

/**
 * The money precision of `currencyCode`, for a transfer leg landing in an
 * account whose currency may differ from the import's. The import account's own
 * currency answers from `ctx.moneyDecimals`; any other code is read once per
 * run and remembered.
 */
export async function currencyMoneyDecimals(
  ctx: Pick<
    ImportContext,
    "manager" | "account" | "moneyDecimals" | "decimalsByCode"
  >,
  currencyCode: string,
): Promise<number> {
  if (currencyCode === ctx.account.currencyCode) {
    return importMoneyDecimals(ctx);
  }
  const memo = (ctx.decimalsByCode ??= new Map<string, number>());
  const known = memo.get(currencyCode);
  if (known !== undefined) return known;
  const places = await loadCurrencyPlaces(ctx.manager, [currencyCode]);
  const decimals = moneyDecimalsForCode(places, currencyCode);
  memo.set(currencyCode, decimals);
  return decimals;
}

/** The money precision of `currencyCode`, read once for an import's account. */
export async function loadMoneyDecimals(
  manager: EntityManager,
  currencyCode: string,
): Promise<number> {
  const places = await loadCurrencyPlaces(manager, [currencyCode]);
  return moneyDecimalsForCode(places, currencyCode);
}

/**
 * The money precision of one account's currency, for a balance move on an
 * account the import context does not describe (a merged-transfer cleanup
 * reaches the counterpart's account). An unknown account or currency reads as
 * the fiat default.
 */
export async function accountMoneyDecimals(
  manager: EntityManager,
  accountId: string,
): Promise<number> {
  const rows = returnedRows(
    await manager.query(
      `SELECT c.decimal_places
         FROM accounts a
         JOIN currencies c ON c.code = a.currency_code
        WHERE a.id = $1`,
      [accountId],
    ),
  ) as Array<{ decimal_places: number | string | null }>;
  const places = rows[0]?.decimal_places;
  return moneyDecimalsFor(places == null ? undefined : Number(places));
}

/**
 * Refuse a file amount with more places than the import account's currency
 * carries (INV-MONEY-001): the row is reported, never stored rounded. The row's
 * savepoint rolls back and the result names it.
 */
export function assertImportAmountPrecision(
  ctx: Pick<ImportContext, "account" | "moneyDecimals">,
  amount: number,
  field: string,
): void {
  assertAmountPrecision(
    amount,
    {
      code: ctx.account.currencyCode,
      decimalPlaces: importMoneyDecimals(ctx),
    },
    field,
  );
}

/** The run's bond state, created on first use (a file with no bond security never pays for it). */
export function bondStateOf(ctx: ImportContext): ImportBondState {
  if (!ctx.bond) {
    const programCache: BondProgramCache = new Map();
    ctx.bond = {
      programCache,
      guard: createBondWriteGuard(ctx.manager, ctx.userId, programCache),
      seriesMemo: new Map(),
    };
  }
  return ctx.bond;
}

/**
 * Count a row the import left out and name it in the result. Every `skipped`
 * increment goes through here, so `skippedRows` is always the first
 * `SKIPPED_ROWS_LIMIT` of the rows `skipped` counts.
 */
export function recordSkippedRow(
  importResult: ImportResultDto,
  row: {
    date: string;
    amount: number;
    payee?: string | null;
    rowNumber?: number;
    rawDate?: string;
  },
  reason: ImportSkipReason,
  currencyCode: string,
): void {
  importResult.skipped++;
  if (importResult.skippedRows.length >= SKIPPED_ROWS_LIMIT) return;
  importResult.skippedRows.push({
    date: row.date,
    amount: row.amount,
    currencyCode,
    payee: row.payee ?? "",
    reason,
    ...(row.rowNumber !== undefined ? { rowNumber: row.rowNumber } : {}),
    ...(row.rawDate !== undefined ? { rawDate: row.rawDate } : {}),
  });
}

/** The result counters one row's processing can raise before it fails. */
const ROW_COUNTERS = [
  "categoriesCreated",
  "accountsCreated",
  "payeesCreated",
  "securitiesCreated",
  "bondRowsWithoutSeries",
  "transactionsChangedByRules",
] as const;

export type RowCounterSnapshot = Pick<
  ImportResultDto,
  (typeof ROW_COUNTERS)[number]
>;

/** The row counters as they stand, taken before a row is processed. */
export function snapshotRowCounters(
  importResult: ImportResultDto,
): RowCounterSnapshot {
  return Object.fromEntries(
    ROW_COUNTERS.map((field) => [field, importResult[field]]),
  ) as RowCounterSnapshot;
}

/**
 * Put the row counters back after a row's savepoint was rolled back: the
 * payee or rule change a counter announced was rolled back with it.
 */
export function restoreRowCounters(
  importResult: ImportResultDto,
  snapshot: RowCounterSnapshot,
): void {
  // The optional counters are absent until a row raises them.
  const counters: Partial<Record<(typeof ROW_COUNTERS)[number], number>> =
    importResult;
  for (const field of ROW_COUNTERS) {
    const value = snapshot[field];
    if (value === undefined) delete counters[field];
    else counters[field] = value;
  }
}

/**
 * Move an account's balance by `amount`, through the same atomic delta
 * statement every balance writer uses (`applyAccountBalanceDelta` in
 * `accounts/accounts.service.ts`; `docs/concurrency-and-idempotency.md`
 * section 2, row 1).
 *
 * One statement, so the read and the write cannot be interleaved: a second
 * delta committing in between composes instead of being overwritten, which a
 * `findOne` followed by an absolute `update` could not promise. The `UPDATE`
 * row-locks `accounts` exactly where the previous one did, so the import's lock
 * order (the `lockHoldingScope` advisory lock is the transaction's first
 * statement) is unchanged.
 *
 * The delta itself is rounded through `roundMoney` at `decimals`, the money
 * precision of the moved account's currency; the sum is rounded by the database. A row that does not exist is
 * a no-op, as before.
 */
export async function updateAccountBalance(
  manager: EntityManager,
  accountId: string,
  amount: number,
  decimals: number,
): Promise<void> {
  const delta = roundMoney(Number(amount) || 0, decimals);
  const updated = await applyAccountBalanceDelta(manager, accountId, delta, {
    openOnly: true,
  });
  if (updated > 0) return;
  // Zero rows is a missing account (a no-op, as before) or a closed one,
  // which an import must refuse as bank sync does.
  const closed = await manager.query(
    `SELECT 1 FROM accounts WHERE id = $1 AND is_closed = true`,
    [accountId],
  );
  if (returnedRows(closed).length > 0) throw closedAccountError();
}

/** The refusal for an import row that would move a closed account's balance. */
export function closedAccountError(): BadRequestException {
  return new BadRequestException(
    tr(
      "errors.import.accountClosed",
      "The account is closed. Reopen it or choose another account.",
    ),
  );
}
