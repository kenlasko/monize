/**
 * Warnings produced while mapping a Money file.
 *
 * A warning is never a failure: the import always completes and tells the user
 * what it assumed or skipped. Codes are stable identifiers that the frontend
 * turns into localized copy (`import.mnyWarnings.<code>`), so a warning never
 * carries an English sentence -- only the code plus the untranslated specifics
 * (an account name, a Money action code, a balance delta) that no catalog can
 * supply.
 */

export const MNY_WARNING_CODES = [
  /** This Money version has no such table; the feature it drives is skipped. */
  "missingTable",
  /** A column the reader wanted is absent, so the field took its default. */
  "missingField",
  /** `ACCT.at` held a code outside the known set; the account is skipped. */
  "unknownAccountType",
  /** Two Money accounts share a name after trimming; the second is suffixed. */
  "duplicateAccountName",
  /** An account or security referenced a currency handle the file lacks. */
  "unknownCurrency",
  /** Money's category tree ran deeper than Monize's two levels. */
  "categoryFlattened",
  /** `CAT.lType` was outside the confirmed set; income/expense came from the tree. */
  "categoryTypeInferred",
  /** A payee named `#`, `*` or blank: Money's degenerate rows, never imported. */
  "degeneratePayeeSkipped",
  /**
   * `TRN.lHcls1` / `lHcls2` named a handle that is not a classification item
   * in `CAT`, so the row imports without that tag.
   */
  "unknownClassificationItem",
  /** A `TRN` row with no account, or a date outside the representable range. */
  "unusableTransaction",
  /** A `TRN_XFER` side whose counterpart is missing or excluded from the import. */
  "orphanedTransferSide",
  /** A `TRN_SPLIT` child whose parent is not being imported. */
  "orphanedSplit",
  /** A split's legs do not add up to the parent transaction's amount. */
  "splitSumMismatch",
  /**
   * A transfer whose counterpart sits in an account the user left out, so the
   * row imports as an ordinary transaction rather than half a transfer.
   */
  "transferAcrossExcludedAccount",
  /** The account's file-computed final balance and its imported balance differ. */
  "balanceMismatch",
  /**
   * Two `SEC` rows resolve to the same symbol, so the second is suffixed
   * (`VOO-2`). PR #192 upserted on the symbol instead and silently collapsed
   * distinct funds into one security.
   */
  "duplicateSecuritySymbol",
  /** A `SEC` row has no symbol; a placeholder was generated and price updates disabled. */
  "generatedSecuritySymbol",
  /** `TRN.act` held a code outside the known set; the investment row is skipped. */
  "unknownInvestmentAction",
  /**
   * A Money 97-99 employee stock option grant, vesting or expiry. It moves no
   * cash and no shares, and Monize has no model for an unexercised option.
   */
  "stockOptionNotImported",
  /** The row was mapped through an action whose meaning is inferred, not observed. */
  "unconfirmedInvestmentAction",
  /** A security-carrying `TRN` row with no `TRN_INV` detail and no way to infer one. */
  "missingInvestmentDetail",
  /** An investment row in an account that is not an investment account. */
  "investmentAccountMismatch",
  /**
   * The file records a stock split that changes a share count, and the import
   * did not apply it -- because Money does not apply it either. See
   * `reportUnappliedSplits`.
   */
  "securitySplitNotApplied",
  /** LOT-derived open shares and the action replay disagree for a holding. */
  "holdingsMismatch",
  /** A `BILL` series whose template transaction is missing from the file. */
  "billTemplateMissing",
  /** A `BILL` series with no usable due date, account or recurrence code. */
  "unusableBill",
  /** A bill recurrence Monize cannot express exactly; the next shorter period is used. */
  "billFrequencyApproximated",
  /**
   * A loan's payments name more than one non-principal category (interest plus
   * escrow, typically), so its interest category was left for the user to set.
   */
  "loanInterestCategoryUnclear",
  /**
   * A bank-to-investment transfer whose investment side Money recorded with a
   * different amount than the bank side, in the same currency. The synthesized
   * cash-sleeve row mirrors the bank side; this compares it with Money's own
   * far row, which the expected-balance check (a sum of the mapped rows) cannot.
   */
  "transferAmountMismatch",
  /**
   * A trade of a security quoted in another currency than its account, for a
   * pair and date the file has no usable exchange rate for. The figures were
   * stored in the account's currency with rate 1, not converted.
   */
  "crossCurrencyTradeUnconverted",
  /**
   * A trade of a security quoted in another currency than its account, which
   * the file had no rate for, converted at the market rate for its date from
   * Monize's rate history and provider instead.
   */
  "crossCurrencyTradeMarketRate",
  /** A KMyMoney account or security uses a currency code Monize cannot hold; its rows are skipped. */
  "unsupportedCurrencyCode",
  /** A transaction with a single split cannot balance and is imported as far as it can be. */
  "singleSplitTransaction",
  /** A transaction's splits do not add up to zero; the residual is reported, not hidden. */
  "unbalancedTransaction",
  /** Two transactions share a (post date, id) pair; the later one replaces the earlier. */
  "duplicateTransactionId",
  /** A split names a payee id no PAYEE element defines; it imports without a payee. */
  "unknownPayeeReference",
  /** A split on an equity account imports as a category. */
  "equitySplitAsCategory",
  /** KMyMoney's account tree ran deeper than Monize's account structure; the hierarchy is flattened. */
  "accountHierarchyFlattened",
  /** An asset-loan account imports as an asset. */
  "assetLoanAsAsset",
  /** A currency trading account imports as an ordinary account. */
  "currencyTradingAccount",
  /** An investment account has no brokerage cash account; a cash side is synthesized. */
  "brokerageAccountNotFound",
  /** The brokerage account's currency differs from the investment account's. */
  "brokerageCurrencyMismatch",
  /** A stock account has no investment parent; its rows import as cash. */
  "stockAccountWithoutInvestment",
  /** A security was not imported, so rows that reference it are not either. */
  "securityNotImported",
  /** An investment transaction shape Monize cannot express imports as a cash row. */
  "investmentImportedAsCash",
  /** An investment transaction carries an extra asset split that is ignored. */
  "investmentExtraAssetSplit",
  /** An income action carries a share count, which is ignored. */
  "investmentSharesOnIncomeAction",
  /** A transaction holds several stock-split splits; only the first is applied. */
  "multipleStockSplits",
  /** A stock-split action inside a multi-split transaction is imported as cash. */
  "splitActionInMultiSplit",
  /** A trade is funded from an equity account. */
  "tradeFundedFromEquity",
  /** Shares were added with no cost recorded. */
  "sharesAddedWithoutCost",
  /** A stock-split ratio was rounded to the quantity precision. */
  "stockSplitRatioRounded",
  /** Rounding the split with the security's method gives a different share count than Monize's. */
  "stockSplitRoundingDiffers",
  /** A stock-split ratio is implausible and was imported as written. */
  "stockSplitRatioSuspicious",
  /** A price row's currency differs from its security's trading currency; it is skipped. */
  "priceCurrencyMismatch",
  /** Exchange rates for currencies the import never uses were skipped. */
  "unusedCurrencyRatesSkipped",
  /** A loan's interest rate history is not imported. */
  "loanInterestRateNotImported",
  /** A loan's payment schedule was simplified to Monize's loan model. */
  "loanScheduleSimplified",
  /** A scheduled investment transaction is not imported. */
  "investmentScheduleNotImported",
  /** A schedule's auto-enter setting is not imported. */
  "scheduleAutoEnterNotImported",
  /** A schedule's weekend-adjustment rule is not imported. */
  "scheduleWeekendRuleDropped",
  /** A schedule is overdue as of the import date. */
  "scheduleOverdue",
  /** The file's cost centers are not imported. */
  "costCentersNotImported",
  /** The file's budgets are not imported. */
  "budgetsNotImported",
  /** The file's reports are not imported. */
  "reportsNotImported",
  /** The file's online jobs are not imported. */
  "onlineJobsNotImported",
  /** The file's online banking settings are not imported. */
  "onlineBankingNotImported",
  /** Account numbers are not imported. */
  "accountNumbersNotImported",
  /** Payee details with no Monize field, or contact details Monize could not read, are not imported. */
  "payeeDetailsNotImported",
  /** A number could not be parsed and was read as zero. */
  "unparsableNumber",
  /** An auto-calculate sentinel appeared in a posted split and was read as zero. */
  "autoCalcInPostedSplit",
  /** An account's imported rows sum to something other than the file's own balance. */
  "mappedBalanceDiffers",
  /** A holding's imported share count differs from KMyMoney's own replay. */
  "holdingsReplayDiffers",
  /** A KMyMoney payee has matching turned off; Monize's exact-name tier still links its name. */
  "payeeMatchingDisabled",
  /** A KMyMoney payee matching key Monize cannot reproduce exactly; it was not imported. */
  "payeeMatchKeyNotImported",
  /** A case-sensitive KMyMoney matching key was imported as an alias, which ignores case. */
  "payeeMatchCaseWidened",
  /** A matching key clashes with another payee's alias or name; it was not imported. */
  "payeeMatchKeyConflict",
  /** An imported alias can match the same text as another payee's alias. */
  "payeeMatchKeyOverlap",
  /** A payee's default category is not a category Monize can use; it was not imported. */
  "payeeDefaultCategoryNotImported",
  /** An existing payee already had its own default category or contact details; they were kept. */
  "payeeDetailsKept",
  /** A KMyMoney cross-currency transfer has no exchange rate in its amounts or the file's prices. */
  "crossCurrencyTransferRateMissing",
] as const;

export type MnyWarningCode = (typeof MNY_WARNING_CODES)[number];

/**
 * The `TRN` row a warning is about, in the terms the mappers have: handles and
 * account keys, not names.
 *
 * Row-level warnings carry one so the review step can show the user *which*
 * transactions were flagged, in enough detail to find them in Money and fix
 * them there before importing. `htrn=14595` alone cannot be searched for in
 * Money's UI; a date, an account, a payee and a cheque number can.
 */
export interface MnyWarningRow {
  /** `TRN.htrn`. Stable across a file, and the last resort when nothing else resolves. */
  readonly handle: number;
  /** Import account key, resolved to the account's name for display. */
  readonly accountKey: string | null;
  /** `TRN.dt` as `YYYY-MM-DD`. */
  readonly date: string | null;
  readonly amount: number | null;
  /** `TRN.lHpay` / `hpay`, resolved to the payee's name for display. */
  readonly payeeHandle: number | null;
  /** `TRN.szId`: the cheque or reference number, which Money's register is searchable by. */
  readonly reference: string | null;
  /** `TRN.mMemo`, truncated -- a memo is free text and can be long. */
  readonly memo: string | null;
}

/** A flagged row with its handles resolved, ready to render. */
export interface MnyFlaggedRow {
  readonly handle: number;
  readonly accountName: string | null;
  readonly date: string | null;
  readonly amount: number | null;
  readonly currencyCode: string | null;
  readonly payeeName: string | null;
  readonly reference: string | null;
  readonly memo: string | null;
  /** This occurrence's specifics, e.g. `legs 1832.07 vs total 1750.44`. */
  readonly detail: string | null;
}

/** One code's worth of warnings, for the review step's grouped display. */
export interface MnyWarningSummary {
  readonly code: MnyWarningCode;
  readonly count: number;
  /** Up to `MAX_WARNING_SAMPLES` subjects, so a 4,000-row warning stays small. */
  readonly samples: readonly string[];
  /**
   * The flagged rows, for the expandable list. Empty for warnings that are not
   * about a transaction (a missing table, a duplicate account name).
   */
  readonly rows: readonly MnyFlaggedRow[];
  /** True when this code has more flagged rows than `rows` carries. */
  readonly rowsTruncated: boolean;
}

export const MAX_WARNING_SAMPLES = 5;

/**
 * Flagged rows kept per code. A preview travels through the Next proxy and is
 * re-fetched on every wizard step, so this is a payload budget as much as a UI
 * one: a single code can raise thousands of warnings on a real file -- 3,255
 * `transferAcrossExcludedAccount` before those became real transfers, and 829
 * `missingInvestmentDetail` still -- and shipping all of them would cost
 * roughly half a megabyte. Fifty
 * is enough to see the shape of a problem; the count still reports the whole of
 * it, and `rowsTruncated` says the list is partial rather than letting it read
 * as complete.
 */
export const MAX_FLAGGED_ROWS = 50;

/** Longest memo carried on a flagged row. */
const MAX_MEMO_LENGTH = 120;

/** Resolves the handles on `MnyWarningRow` to the names a user recognizes. */
export interface MnyWarningLookup {
  accountName(key: string): string | null;
  currencyCode(key: string): string | null;
  payeeName(handle: number): string | null;
}

/**
 * Builds a lookup from the mapped accounts and payees.
 *
 * Structurally typed rather than taking `MnyParsedFile` so this module stays a
 * leaf -- the parser imports it, not the other way round. Both surfaces that
 * summarize warnings (the wizard's preview and the post-import verification
 * report) build it the same way, so a flagged row reads identically in both.
 */
export function warningLookup(input: {
  readonly accounts: readonly {
    readonly key: string;
    readonly name: string;
    readonly currencyCode: string;
  }[];
  readonly payeeNameByHandle: ReadonlyMap<number, string>;
}): MnyWarningLookup {
  const accounts = new Map(
    input.accounts.map((account) => [account.key, account]),
  );
  return {
    accountName: (key) => accounts.get(key)?.name ?? null,
    currencyCode: (key) => accounts.get(key)?.currencyCode ?? null,
    payeeName: (handle) => input.payeeNameByHandle.get(handle) ?? null,
  };
}

function truncate(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  return text.length > MAX_MEMO_LENGTH
    ? `${text.slice(0, MAX_MEMO_LENGTH)}...`
    : text;
}

function flagRow(
  warning: MnyWarning,
  lookup: MnyWarningLookup | undefined,
): MnyFlaggedRow | null {
  const row = warning.row;
  if (row === undefined) {
    return null;
  }
  return {
    handle: row.handle,
    accountName:
      row.accountKey === null
        ? null
        : (lookup?.accountName(row.accountKey) ?? null),
    date: row.date,
    amount: row.amount,
    currencyCode:
      row.accountKey === null
        ? null
        : (lookup?.currencyCode(row.accountKey) ?? null),
    payeeName:
      row.payeeHandle === null
        ? null
        : (lookup?.payeeName(row.payeeHandle) ?? null),
    reference: row.reference,
    memo: truncate(row.memo),
    detail: warning.detail ?? null,
  };
}

export interface MnyWarning {
  readonly code: MnyWarningCode;
  /**
   * The Money entity the warning is about -- an account or payee name, a table
   * name, a transaction handle. Untranslated by design.
   */
  readonly subject?: string;
  /** Extra specifics: a raw code, a delta, the column that was missing. */
  readonly detail?: string;
  /**
   * Set by the mappers on warnings that are about one `TRN` row, so the review
   * step can list them for the user to fix in Money before importing.
   */
  readonly row?: MnyWarningRow;
}

/**
 * Groups warnings by code, keeping a bounded sample of subjects and a bounded
 * list of flagged rows. The preview and the verification report both travel as
 * JSON through a polling endpoint, so an unbounded warning list is a payload
 * problem, not just a UI one.
 */
export function summarizeWarnings(
  warnings: readonly MnyWarning[],
  lookup?: MnyWarningLookup,
): MnyWarningSummary[] {
  return MNY_WARNING_CODES.filter((code) =>
    warnings.some((warning) => warning.code === code),
  ).map((code) => {
    const matching = warnings.filter((warning) => warning.code === code);
    const rows = matching
      .map((warning) => flagRow(warning, lookup))
      .filter((row): row is MnyFlaggedRow => row !== null);
    return {
      code,
      count: matching.length,
      samples: matching
        .map((warning) => warning.subject)
        .filter((subject): subject is string => subject !== undefined)
        .slice(0, MAX_WARNING_SAMPLES),
      rows: rows.slice(0, MAX_FLAGGED_ROWS),
      rowsTruncated: rows.length > MAX_FLAGGED_ROWS,
    };
  });
}
