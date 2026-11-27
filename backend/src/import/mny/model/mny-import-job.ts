import { MnyWarningSummary } from "./mny-warnings";

/**
 * The shape of a background import job as the wizard sees it.
 *
 * A `.mny` file with 37,000 transactions cannot finish inside a request, so the
 * import is a job row the wizard polls (design ADR-3). Everything here travels
 * as JSON in `import_jobs.progress` / `.result`, so it is deliberately flat and
 * free of English copy: phases and warning codes are localized by the frontend.
 */

export const IMPORT_JOB_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
] as const;

export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

/** Ordered so the wizard can render a progress rail, not just a label. */
export const MNY_IMPORT_PHASES = [
  "preparing",
  "reference",
  "transactions",
  "investments",
  "bills",
  "prices",
  "finalizing",
  "verifying",
] as const;

export type MnyImportPhase = (typeof MNY_IMPORT_PHASES)[number];

export interface MnyImportProgress {
  readonly phase: MnyImportPhase;
  /** Rows finished in this phase; 0 when the phase has no meaningful count. */
  readonly processed: number;
  /** Rows this phase will process, or 0 when not countable up front. */
  readonly total: number;
}

/** One account's line in the verification report. */
export interface MnyAccountVerification {
  readonly accountName: string;
  /**
   * So the report can show *what kind* of account a discrepancy is on. Loans
   * and mortgages are the ones worth calling out: they are where PR #192's
   * phantom-row filter silently produced empty accounts, and a delta there
   * means something different than a delta on a chequing account.
   */
  readonly accountType: string;
  /** Null when the account was skipped or failed to create. */
  readonly accountId: string | null;
  /** Final balance computed from the Money file by the parser. */
  readonly expectedBalance: number;
  /** Balance Monize holds after the import. */
  readonly importedBalance: number;
  /** `importedBalance - expectedBalance`, rounded to four places. */
  readonly delta: number;
  readonly transactionCount: number;
  /** True when `delta` is within the reconciliation tolerance. */
  readonly matches: boolean;
  /**
   * KMyMoney only: what the import's own rows sum to; `expectedBalance` is then
   * the file's figure. Absent means the Money behaviour.
   */
  readonly mappedBalance?: number;
  /**
   * KMyMoney only: true when `mappedBalance` differs from `expectedBalance`
   * at the account's own decimal places, so the report need not guess a
   * tolerance of its own.
   */
  readonly mappedDiffers?: boolean;
  /** KMyMoney only: the account's currency, which the report formats it in. */
  readonly currencyCode?: string;
}

/**
 * One holding's line in the verification report.
 *
 * Three independent readings of the same position: what Money's open tax lots
 * say, what replaying the mapped actions produces, and what Monize actually
 * holds once `HoldingsService` has rebuilt from the imported rows. The lots are
 * the authority -- they are the record Money itself reconciles against.
 */
export interface MnyHoldingVerification {
  readonly accountName: string;
  readonly symbol: string;
  /** The file's own share count: Money's open lots, or KMyMoney's replay. */
  readonly lotQuantity: number;
  /** Shares the mapper's own action replay produces. */
  readonly replayQuantity: number;
  /** Shares Monize holds after the import. */
  readonly importedQuantity: number;
  /** `importedQuantity - lotQuantity`. */
  readonly delta: number;
  readonly matches: boolean;
}

/** What the import created, and whether the result reconciles. */
export interface MnyImportResult {
  readonly accountsCreated: number;
  readonly payeesCreated: number;
  readonly categoriesCreated: number;
  /** Tags created for Money's classification items; a reused tag is not counted. */
  readonly tagsCreated: number;
  /** Tag links written onto transactions and split legs, new tags or reused. */
  readonly tagLinksApplied: number;
  readonly transactionsCreated: number;
  readonly splitsCreated: number;
  readonly transfersLinked: number;
  readonly securitiesCreated: number;
  readonly investmentTransactionsCreated: number;
  readonly pricesImported: number;
  readonly exchangeRatesImported: number;
  readonly billsCreated: number;
  /**
   * Acquisitions of a bond-program security imported without a series (the file
   * names none and none was on sale on the date): the bond lots report such a
   * row until its series is chosen. Absent when zero.
   */
  readonly bondRowsWithoutSeries?: number;
  /**
   * Rows and split lines imported without the file's category because it is
   * a Transfer category (merged into one a person made), which goes only on a
   * transfer (INV-CATEGORY-001). Absent when zero.
   */
  readonly categoriesNotFitting?: number;
  /** Payee aliases written (KMyMoney file only; absent for Money). */
  readonly payeeAliasesCreated?: number;
  /**
   * KMyMoney only: the date the file's figures in `verification` and
   * `holdings` are computed at, the commit's own day (`todayYMD`, the same
   * cut-off post-processing gives `current_balance`). The preview shows its
   * own (`kmyFile.asOf`); the two differ only when the import started on a
   * later day than the upload.
   */
  readonly fileAsOf?: string;
  /** Payees that received a default category (KMyMoney file only). */
  readonly payeeDefaultCategoriesSet?: number;
  /** Payees that received at least one contact field (KMyMoney file only). */
  readonly payeeContactDetailsSet?: number;
  /** Rows the mapper could not use, by reason. Mirrors the warning codes. */
  readonly skipped: {
    readonly accounts: number;
    readonly payees: number;
    readonly categories: number;
    /** Classification items no imported row references. */
    readonly tags: number;
    readonly transactions: number;
    /** Bill series with no usable template or date -- not unticked ones. */
    readonly bills: number;
  };
  /** True when the wizard's wipe option ran the delete-my-data pre-step. */
  readonly existingDataRemoved: boolean;
  readonly verification: readonly MnyAccountVerification[];
  /** Empty when the file has no `LOT` table or the import created no holdings. */
  readonly holdings: readonly MnyHoldingVerification[];
  readonly warnings: readonly MnyWarningSummary[];
}

/**
 * A balance is considered reconciled within half a cent. Money and Monize both
 * store four decimal places, but a file whose amounts were entered in a
 * different currency's minor unit can differ in the fourth place without
 * anything being wrong.
 */
export const BALANCE_TOLERANCE = 0.005;

export function balanceMatches(delta: number): boolean {
  return Math.abs(delta) <= BALANCE_TOLERANCE;
}

/**
 * Share counts are `decimal(20,8)`, so anything smaller than the last stored
 * place is rounding rather than a real discrepancy.
 */
export const QUANTITY_TOLERANCE = 0.00000001;

export function quantityMatches(delta: number): boolean {
  return Math.abs(delta) <= QUANTITY_TOLERANCE;
}
