import type { DocsLink } from '@/lib/docs-links';
import { mnyImportApi, type BinaryImportClient } from '@/lib/import-mny';
import { kmyImportApi } from '@/lib/import-kmy';
import { mnyErrorDocsLink } from '@/lib/import-mny-error-docs';
import { kmyErrorDocsLink } from '@/lib/import-kmy-error-docs';

/**
 * Everything the shared binary-file import components (`Mny*`, `UploadStep`,
 * `useMnyImport`) need to know about the file format they are importing: the
 * API client, the translation keys for every sentence whose wording differs,
 * the resolvers for warning and error keys, and a few switches for sections
 * one format has and the other does not. A format is added here, not by
 * copying a component. A Money import uses `MNY_FORMAT`, the default of every
 * component, and renders exactly as it did before the descriptor existed.
 */

export type BinaryImportFormatId = 'mny' | 'kmy';

/** Every key is in the `import` namespace. */
export interface BinaryImportCopy {
  readonly reviewHeading: string;
  readonly fileSummary: string;
  readonly renamedFrom: string;
  readonly referencedOnlyPayeesHint: string;
  readonly referencedOnlyCategoriesHint: string;
  readonly importPricesHint: string;
  readonly wipeExistingDataHint: string;
  readonly countsTags: string;
  readonly countsBills: string;
  readonly countsBillsOfRows: string;
  readonly billsHeading: string;
  readonly billsExplainer: string;
  readonly billsSkipped: string;
  readonly importingHeading: string;
  readonly uploadFailedHeading: string;
  readonly allMatch: string;
  readonly someDiffer: string;
  readonly someHoldingsDiffer: string;
  readonly holdingsExplainer: string;
  readonly tableExpected: string;
  readonly tableLotShares: string;
  readonly reviewInSource: string;
  readonly reviewInSourceTruncated: string;
  readonly singleFileOnly: string;
  /**
   * The payee-alias tiles of the review step and the report. Optional: only a
   * format whose importer writes payee aliases names them (KMyMoney).
   */
  readonly countsPayeeAliases?: string;
  readonly countsPayeeAliasesDetail?: string;
  /** KMyMoney only: the review line saying the day balances are cut off at. */
  readonly reviewAsOf?: string;
  /** KMyMoney only: the report line saying the day the verification is cut off at. */
  readonly completeAsOf?: string;
  readonly completePayeeAliases?: string;
  readonly completePayeeDefaultCategories?: string;
}

export interface BinaryImportFormat {
  readonly id: BinaryImportFormatId;
  readonly client: BinaryImportClient;
  /** What the report download's name strips from the file name. */
  readonly reportExtension: RegExp;
  /** Money's file format version is a named era; KMyMoney's is a number in the summary. */
  readonly showEra: boolean;
  /** Money versions lack tables; a KMyMoney file always has them all. */
  readonly showMissingTables: boolean;
  readonly passwordPrompt: boolean;
  readonly copy: BinaryImportCopy;
  /** Error code shown when an upload fails with no message of its own. */
  readonly uploadFallbackErrorCode: string;
  readonly warningKey: (code: string) => string;
  readonly errorKey: (code: string) => string;
  readonly errorDocsLink: (code: string | null | undefined) => DocsLink;
}

/**
 * Every warning code a KMyMoney import can raise, copied verbatim from the
 * backend's `KMY_WARNING_CODES` (`backend/src/import/kmy/model/kmy-warnings.ts`).
 * `binary-import-format.test.ts` asserts each has an English sentence.
 */
export const KMY_WARNING_CODES: readonly string[] = [
  'unknownAccountType',
  'duplicateAccountName',
  'unknownCurrency',
  'unusableTransaction',
  'transferAcrossExcludedAccount',
  'duplicateSecuritySymbol',
  'generatedSecuritySymbol',
  'balanceMismatch',
  'holdingsMismatch',
  'unusableBill',
  'billFrequencyApproximated',
  'loanInterestCategoryUnclear',
  'crossCurrencyTradeUnconverted',
  'unsupportedCurrencyCode',
  'singleSplitTransaction',
  'unbalancedTransaction',
  'duplicateTransactionId',
  'unknownPayeeReference',
  'equitySplitAsCategory',
  'accountHierarchyFlattened',
  'assetLoanAsAsset',
  'currencyTradingAccount',
  'brokerageAccountNotFound',
  'brokerageCurrencyMismatch',
  'stockAccountWithoutInvestment',
  'securityNotImported',
  'investmentImportedAsCash',
  'investmentExtraAssetSplit',
  'investmentSharesOnIncomeAction',
  'multipleStockSplits',
  'splitActionInMultiSplit',
  'tradeFundedFromEquity',
  'sharesAddedWithoutCost',
  'stockSplitRatioRounded',
  'stockSplitRoundingDiffers',
  'stockSplitRatioSuspicious',
  'priceCurrencyMismatch',
  'unusedCurrencyRatesSkipped',
  'loanInterestRateNotImported',
  'loanScheduleSimplified',
  'investmentScheduleNotImported',
  'scheduleAutoEnterNotImported',
  'scheduleWeekendRuleDropped',
  'scheduleOverdue',
  'costCentersNotImported',
  'budgetsNotImported',
  'reportsNotImported',
  'onlineJobsNotImported',
  'onlineBankingNotImported',
  'accountNumbersNotImported',
  'payeeDetailsNotImported',
  'unparsableNumber',
  'autoCalcInPostedSplit',
  'mappedBalanceDiffers',
  'holdingsReplayDiffers',
  'payeeMatchingDisabled',
  'payeeMatchKeyNotImported',
  'payeeMatchCaseWidened',
  'payeeMatchKeyConflict',
  'payeeMatchKeyOverlap',
  'payeeDefaultCategoryNotImported',
  'payeeDetailsKept',
  'crossCurrencyTransferRateMissing',
  'tradeAmountsDiffer',
  'investmentTransactionUnclassified',
  'sameAccountTransferUnlinked',
  'reconciliationHistoryNotImported',
  'securityTransferInferred',
  'sharesRounded',
];

/**
 * The error codes the KMyMoney import reports with a sentence of its own in
 * `import.kmyErrors`: the backend's `KmyErrorCode` plus the staged-file one.
 */
export const KMY_ERROR_CODES: readonly string[] = [
  'kmyNotAKmyMoneyFile',
  'kmyEncryptedFile',
  'kmySqliteDatabase',
  'kmyAnonymizedFile',
  'kmyLegacyBinaryFile',
  'kmyCorruptFile',
  'kmyXmlTooLarge',
  'kmyTooManyRecords',
  'kmyMappingFailed',
  'kmyStagedFileMissing',
];

export const MNY_FORMAT: BinaryImportFormat = {
  id: 'mny',
  client: mnyImportApi,
  reportExtension: /\.mny$/i,
  showEra: true,
  showMissingTables: true,
  passwordPrompt: true,
  copy: {
    reviewHeading: 'mnyReview.heading',
    fileSummary: 'mnyReview.fileSummary',
    renamedFrom: 'mnyReview.table.renamedFrom',
    referencedOnlyPayeesHint: 'mnyReview.options.referencedOnlyPayeesHint',
    referencedOnlyCategoriesHint:
      'mnyReview.options.referencedOnlyCategoriesHint',
    importPricesHint: 'mnyReview.options.importPricesHint',
    wipeExistingDataHint: 'mnyReview.options.wipeExistingDataHint',
    countsTags: 'mnyReview.counts.tags',
    countsBills: 'mnyReview.counts.bills',
    countsBillsOfRows: 'mnyReview.counts.billsOfRows',
    billsHeading: 'mnyBills.heading',
    billsExplainer: 'mnyBills.explainer',
    billsSkipped: 'mnyBills.skipped',
    importingHeading: 'mnyImporting.heading',
    uploadFailedHeading: 'upload.mnyFailedHeading',
    allMatch: 'mnyComplete.allMatch',
    someDiffer: 'mnyComplete.someDiffer',
    someHoldingsDiffer: 'mnyComplete.someHoldingsDiffer',
    holdingsExplainer: 'mnyComplete.holdingsExplainer',
    tableExpected: 'mnyComplete.table.expected',
    tableLotShares: 'mnyComplete.table.lotShares',
    reviewInSource: 'mnyWarnings.reviewInMoney',
    reviewInSourceTruncated: 'mnyWarnings.reviewInMoneyTruncated',
    singleFileOnly: 'toasts.mnySingleFileOnly',
  },
  uploadFallbackErrorCode: 'mnyUnreadableDatabase',
  warningKey: (code) => `mnyWarnings.${code}`,
  errorKey: (code) => `mnyErrors.${code}`,
  errorDocsLink: mnyErrorDocsLink,
};

export const KMY_FORMAT: BinaryImportFormat = {
  id: 'kmy',
  client: kmyImportApi,
  reportExtension: /\.(kmy|xml)$/i,
  showEra: false,
  showMissingTables: false,
  passwordPrompt: false,
  copy: {
    reviewHeading: 'kmyReview.heading',
    fileSummary: 'kmyReview.fileSummary',
    renamedFrom: 'kmyReview.renamedFrom',
    referencedOnlyPayeesHint: 'kmyReview.referencedOnlyPayeesHint',
    referencedOnlyCategoriesHint: 'kmyReview.referencedOnlyCategoriesHint',
    importPricesHint: 'kmyReview.importPricesHint',
    wipeExistingDataHint: 'kmyReview.wipeExistingDataHint',
    // The labels the spec words for KMyMoney (tags, scheduled transactions).
    countsTags: 'kmyReview.counts.tags',
    countsBills: 'kmyReview.counts.bills',
    countsBillsOfRows: 'kmyReview.counts.billsOfRows',
    billsHeading: 'kmyBills.heading',
    billsExplainer: 'kmyBills.explainer',
    billsSkipped: 'kmyBills.skipped',
    importingHeading: 'kmyImporting.heading',
    uploadFailedHeading: 'upload.kmyFailedHeading',
    allMatch: 'kmyComplete.allMatch',
    someDiffer: 'kmyComplete.someDiffer',
    someHoldingsDiffer: 'kmyComplete.someHoldingsDiffer',
    holdingsExplainer: 'kmyComplete.holdingsExplainer',
    tableExpected: 'kmyComplete.table.expected',
    tableLotShares: 'kmyComplete.table.lotShares',
    reviewInSource: 'kmyWarnings.reviewInKmy',
    reviewInSourceTruncated: 'kmyWarnings.reviewInKmyTruncated',
    singleFileOnly: 'toasts.kmySingleFileOnly',
    countsPayeeAliases: 'kmyReview.counts.payeeAliases',
    countsPayeeAliasesDetail: 'kmyReview.counts.payeeAliasesDetail',
    reviewAsOf: 'kmyReview.asOf',
    completeAsOf: 'kmyComplete.asOf',
    completePayeeAliases: 'kmyComplete.counts.payeeAliases',
    completePayeeDefaultCategories: 'kmyComplete.counts.payeeDefaultCategories',
  },
  uploadFallbackErrorCode: 'kmyCorruptFile',
  warningKey: (code) => `kmyWarnings.${code}`,
  // The KMyMoney import reports its own `kmy*` codes, and the staged-file one
  // by the Money name; every other job key (stalled, failed, already imported)
  // is format-neutral and reads from the Money catalog.
  errorKey: (code) => {
    if (code === 'mnyStagedFileMissing') return 'kmyErrors.kmyStagedFileMissing';
    return code.startsWith('kmy') ? `kmyErrors.${code}` : `mnyErrors.${code}`;
  },
  errorDocsLink: kmyErrorDocsLink,
};

/** The staged file is gone: the review step offers to upload it again. */
export function isStagedFileMissing(code: string | undefined): boolean {
  return code === 'mnyStagedFileMissing' || code === 'kmyStagedFileMissing';
}
