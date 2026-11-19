import type { Rational } from "./kmy-rational";

/**
 * The reader's output: KMyMoney's file as plain data, before any mapping.
 * Types only. Every field is readonly; ordinals are 1-based positions in the
 * file's own section, counted before any filtering (spec 4.6).
 */

export type KmyAmount = Rational | "autoCalc";

export interface KmyFileInfo {
  container: "gzip" | "xml";
  fixVersion: number;
  appVersion: string | null;
  creationDate: string | null;
  lastModified: string | null;
}

export interface KmyInstitution {
  ordinal: number;
  id: string;
  name: string;
  accountIds: readonly string[];
}

/** How KMyMoney matches an imported payee text to a payee (reference 10.1). */
export type KmyPayeeMatchKind = "disabled" | "name" | "nameExact" | "key";

export interface KmyPayeeMatch {
  kind: KmyPayeeMatchKind;
  /** `matchignorecase`; absent is false (case-sensitive). */
  ignoreCase: boolean;
  /**
   * "key" only: the keys of `matchkey`, split on a line feed (else on `;`), with
   * empty and all-space keys dropped. Keys are never trimmed.
   */
  keys: readonly string[];
}

export interface KmyPayeeAddress {
  street: string;
  city: string;
  /** `state`, else `country`, else `county` (R2.4). */
  state: string;
  /** `zip`, else `zipcode`, else `postcode` (R2.4). */
  postcode: string;
  telephone: string;
}

export interface KmyPayee {
  ordinal: number;
  id: string;
  name: string;
  match: KmyPayeeMatch;
  /** `defaultaccountid`; null when absent or empty. */
  defaultAccountId: string | null;
  notes: string;
  email: string;
  reference: string;
  address: KmyPayeeAddress;
  /** Any payeeIdentifier child. */
  hasIdentifiers: boolean;
  /** A non-empty `idpattern` or `urltemplate`. */
  hasLinkPattern: boolean;
}

export interface KmyTag {
  ordinal: number;
  id: string;
  name: string;
  closed: boolean;
}

export interface KmyCostCenter {
  ordinal: number;
  id: string;
  name: string;
}

export interface KmyReconciliation {
  date: string;
  value: Rational;
}

export interface KmyAccount {
  ordinal: number;
  id: string;
  /** The id starts "AStd::". */
  isStandard: boolean;
  parentId: string | null;
  name: string;
  /** A missing or invalid type reads as 0. */
  type: number;
  currency: string | null;
  institutionId: string | null;
  opened: string | null;
  lastReconciled: string | null;
  number: string;
  description: string;
  subaccountIds: readonly string[];
  reconciliations: readonly KmyReconciliation[];
  /** Legacy IBAN folded into iban (iban wins); lastStatementDate dropped (reference 2.4). */
  kvp: ReadonlyMap<string, string>;
  /** No ONLINEBANKING attribute is stored. */
  hasOnlineBanking: boolean;
}

export interface KmySplit {
  /** 1-based within its transaction, after dropping empty-account splits. */
  ordinal: number;
  account: string;
  payee: string | null;
  value: Rational;
  shares: Rational;
  price: Rational;
  action: string;
  reconcileFlag: number;
  reconcileDate: string | null;
  memo: string;
  number: string;
  bankId: string;
  costCenter: string | null;
  tags: readonly string[];
  hasMatchedTransaction: boolean;
}

export interface KmyTemplateSplit extends Omit<KmySplit, "value" | "shares"> {
  value: KmyAmount;
  shares: KmyAmount;
}

export interface KmyTransaction {
  ordinal: number;
  id: string;
  postDate: string | null;
  memo: string;
  commodity: string | null;
  splits: readonly KmySplit[];
  kvp: ReadonlyMap<string, string>;
}

export interface KmyTemplateTransaction {
  postDate: string | null;
  memo: string;
  commodity: string | null;
  splits: readonly KmyTemplateSplit[];
}

export interface KmySchedule {
  ordinal: number;
  id: string;
  name: string;
  type: number;
  /** Raw; a multiplier below 1 is read as 1. */
  occurrence: number;
  multiplier: number;
  paymentType: number;
  startDate: string | null;
  endDate: string | null;
  lastPayment: string | null;
  fixed: boolean;
  autoEnter: boolean;
  lastDayInMonth: boolean;
  weekendOption: number;
  payments: readonly string[];
  template: KmyTemplateTransaction | null;
}

export interface KmySecurity {
  ordinal: number;
  id: string;
  name: string;
  symbol: string;
  type: number;
  /** 0 or missing reads as 100n. */
  saf: bigint;
  /** 0 or above 10 reads as 4. */
  pp: number;
  /** Missing reads as 0. */
  roundingMethod: number;
  tradingCurrency: string | null;
  tradingMarket: string;
  kvp: ReadonlyMap<string, string>;
}

export interface KmyCurrency {
  ordinal: number;
  id: string;
  name: string;
  symbol: string;
  saf: bigint;
  scf: bigint;
  pp: number;
  roundingMethod: number;
}

export interface KmyPrice {
  ordinal: number;
  from: string;
  to: string;
  date: string;
  price: Rational;
  source: string;
}

export interface KmyCounts {
  reports: number;
  budgets: number;
  onlineJobs: number;
  matchedTransactions: number;
  onlineBankingAccounts: number;
}

export interface KmyReaderWarning {
  code: "unparsableNumber" | "autoCalcInPostedSplit" | "duplicateTransactionId";
  subject: string;
  transactionOrdinal: number | null;
}

export interface KmyRawFile {
  fileInfo: KmyFileInfo;
  baseCurrency: string | null;
  institutions: readonly KmyInstitution[];
  payees: readonly KmyPayee[];
  tags: readonly KmyTag[];
  costCenters: readonly KmyCostCenter[];
  accounts: readonly KmyAccount[];
  /** After the (postdate, id) collapse; zero-split ones kept. */
  transactions: readonly KmyTransaction[];
  schedules: readonly KmySchedule[];
  securities: readonly KmySecurity[];
  currencies: readonly KmyCurrency[];
  prices: readonly KmyPrice[];
  counts: KmyCounts;
  readerWarnings: readonly KmyReaderWarning[];
}
