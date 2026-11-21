/**
 * What the wizard's review step decides, and the import obeys (design ADR-5).
 *
 * The backend owns the defaults so the parse response can echo them back: a
 * client that sends nothing gets the documented behaviour, and a client that
 * sends a subset gets the rest filled in server-side rather than from whatever
 * the frontend happened to initialize its form state to.
 */

/** Per-account decisions taken in the review table. */
export interface MnyAccountOption {
  /** `ACCT.hacct` of the account this applies to. */
  readonly handle: number;
  /** False leaves the account and all of its transactions out entirely. */
  readonly include: boolean;
  /**
   * ISO code overriding the currency Money recorded, for files where an account
   * was set up under the wrong currency. Null keeps the file's own value.
   */
  readonly currencyOverride: string | null;
}

/** What a too-long name belongs to; see `MnyRename`. */
export type MnyRenameKind =
  "payee" | "account" | "category" | "security" | "schedule" | "institution";

export const MNY_RENAME_KINDS: readonly MnyRenameKind[] = [
  "payee",
  "account",
  "category",
  "security",
  "schedule",
  "institution",
];

/**
 * The name the user chose for one file element whose own name is longer than
 * the Monize column it lands in (issue #2313). `handle` is the element's
 * ordinal within its section of the file (a category is a KMyMoney account, so
 * it shares the account ordinals). Only a name that does not fit is replaced;
 * a rename of anything else is ignored.
 */
export interface MnyRename {
  readonly kind: MnyRenameKind;
  readonly handle: number;
  readonly name: string;
}

export interface MnyImportOptions {
  /**
   * Run the existing selective delete-my-data operation before importing.
   * Default false: the importer itself never deletes anything.
   */
  readonly wipeExistingData: boolean;
  /** Create only payees an imported transaction actually references. */
  readonly referencedOnlyPayees: boolean;
  /** Create only categories an imported transaction or split references. */
  readonly referencedOnlyCategories: boolean;
  /** Closed Money accounts still carry history worth importing. */
  readonly importClosedAccounts: boolean;
  /** `SP` security price history. */
  readonly importPrices: boolean;
  /** `CRNC_EXCHG` exchange-rate history. */
  readonly importExchangeRates: boolean;
  /**
   * Per-account overrides. An account absent from this list takes the defaults
   * (included, file currency), so an empty list means "import everything".
   */
  readonly accounts: readonly MnyAccountOption[];
  /**
   * `BILL.hbill` handles the user ticked. An explicit empty list means no
   * bills; a request that omits the field entirely gets the server default of
   * every detected-active candidate (the parser resolves this, since only it
   * knows the candidates).
   */
  readonly bills: readonly number[];
  /**
   * Replacement names for the file's too-long names (KMyMoney only; a Money
   * file ignores it). A too-long name with no usable entry here is shortened
   * to fit, so the import never fails on a name's length. The preview echoes
   * the shortened names it would use, so the wizard starts from them.
   */
  readonly renames: readonly MnyRename[];
}

export const DEFAULT_MNY_IMPORT_OPTIONS: MnyImportOptions = {
  wipeExistingData: false,
  referencedOnlyPayees: true,
  referencedOnlyCategories: true,
  importClosedAccounts: true,
  importPrices: true,
  importExchangeRates: true,
  accounts: [],
  bills: [],
  renames: [],
};

/** Fills a partial option set from the defaults. */
export function resolveImportOptions(
  partial: Partial<MnyImportOptions> | null | undefined,
): MnyImportOptions {
  return { ...DEFAULT_MNY_IMPORT_OPTIONS, ...(partial ?? {}) };
}

/**
 * Whether an account is included, and under which currency. Absent accounts are
 * included by default; a closed account additionally obeys
 * `importClosedAccounts`, so unticking that box does not require the wizard to
 * enumerate every closed account.
 */
export function accountSelection(
  options: MnyImportOptions,
  handle: number | null,
  closed: boolean,
): { include: boolean; currencyOverride: string | null } {
  const explicit =
    handle === null
      ? undefined
      : options.accounts.find((entry) => entry.handle === handle);

  if (explicit) {
    return {
      include: explicit.include,
      currencyOverride: explicit.currencyOverride,
    };
  }

  return {
    include: closed ? options.importClosedAccounts : true,
    currencyOverride: null,
  };
}
