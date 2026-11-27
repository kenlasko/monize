import {
  AccountSubType,
  AccountType,
  InterestBookingMode,
} from "../../../accounts/entities/account.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { MnyWarning } from "./mny-warnings";
import type { MnyRenameKind } from "./mny-import-options";
import type { CustomRecurrence } from "../../../common/custom-recurrence";
import type { SecurityType } from "../../../securities/security-enums";

/**
 * The intermediate representation the mappers produce and the writer consumes
 * (design ADR-8).
 *
 * Deliberately its own model rather than the QIF parser's: the QIF shape cannot
 * carry exact transfer links, per-account currencies, closed/favourite flags, or
 * investment transfer semantics -- and the QIF processor's name-and-amount
 * transfer *matching* is exactly what a file with authoritative `TRN_XFER` pairs
 * must never fall back to.
 *
 * Nothing here touches the database. Identities are import-local keys and
 * pre-generated UUIDs, so transfer pairs and splits are fully wired before the
 * first INSERT.
 */

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface MappedAccount {
  /**
   * Identity within this import. A Money account maps to `acct-<hacct>`; the
   * cash side Monize requires for an investment account that has no Money
   * companion is `acct-<hacct>-cash`.
   */
  readonly key: string;
  /**
   * The Money `hacct` whose transactions land in this account, or null for a
   * synthesized investment cash side.
   */
  readonly handle: number | null;
  /** Name Monize will use, after de-duplication and pair suffixing. */
  readonly name: string;
  /** Name as Money recorded it, for the review table and warnings. */
  readonly moneyName: string;
  readonly accountType: AccountType;
  readonly accountSubType: AccountSubType | null;
  readonly currencyCode: string;
  /**
   * Institution name written to the account. Absent means the writer's previous
   * behaviour (`null`).
   */
  readonly institutionName?: string | null;
  readonly openingBalance: number;
  readonly creditLimit: number | null;
  /**
   * Applied **after** the account's transactions are written:
   * `AccountsService.updateBalance` rejects closed accounts.
   */
  readonly closed: boolean;
  readonly closedDate: string | null;
  readonly favourite: boolean;
  /**
   * True for Money's watch accounts (`ACCT.fWatch`): they track quotes, not
   * money, so their Monize accounts are excluded from net worth.
   */
  readonly excludeFromNetWorth: boolean;
  readonly description: string | null;
  /** The other half of an investment pair, by `key`. */
  readonly linkedKey: string | null;
}

export interface MappedAccounts {
  /** The file's own base currency, or the user's preference when it has none. */
  readonly baseCurrency: string;
  /** ISO codes the import must ensure exist, base currency included. */
  readonly currencyCodes: readonly string[];
  readonly accounts: readonly MappedAccount[];
  /** Money `hacct` -> account key. An excluded account is absent. */
  readonly keyByHandle: ReadonlyMap<number, string>;
  /** Money `hacct` -> currency of the Monize account it maps to. */
  readonly currencyByHandle: ReadonlyMap<number, string>;
  /** Accounts left out by an unknown type or by the wizard's selection. */
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Categories and payees
// ---------------------------------------------------------------------------

export interface MappedCategory {
  /** `CAT.hcat`. */
  readonly handle: number;
  /** Monize parent name, or null for a top-level category. */
  readonly parentName: string | null;
  /**
   * Monize category name. A Money tree deeper than two levels is flattened
   * into a colon-joined child name (`Utilities:Gas:Winter` -> parent
   * `Utilities`, name `Gas:Winter`).
   */
  readonly name: string;
  /** `parentName:name`, the writer's find-or-create identity. */
  readonly fullName: string;
  readonly isIncome: boolean;
}

export interface MappedCategories {
  /** Unique by `fullName`, ordered parents-before-children. */
  readonly categories: readonly MappedCategory[];
  /** Every `hcat` that maps somewhere, including duplicates by name. */
  readonly byHandle: ReadonlyMap<number, MappedCategory>;
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

/** A payee's contact details, already validated against the payee DTO bounds (KMyMoney import). */
export interface MappedPayeeContact {
  /** Sanitized, at most 500 characters. */
  readonly notes: string | null;
  /** Passes `isEmail`, at most 255 characters. */
  readonly email: string | null;
  /** `normalizePhoneNumber`'s stored form. */
  readonly phone: string | null;
  /** Street, city, state and postcode joined with ", ", sanitized, at most 500. */
  readonly address: string | null;
}

export interface MappedPayee {
  readonly handle: number;
  readonly name: string;
  /**
   * Monize alias globs, translated and collision-checked within the file.
   * Only the KMyMoney importer sets the three optional fields below; a Money
   * payee never carries them. Absent: none.
   */
  readonly aliases?: readonly string[];
  /** Handle in `MappedCategories.byHandle` of the default category. Absent or null: none. */
  readonly defaultCategoryHandle?: number | null;
  /** Absent: none. */
  readonly contact?: MappedPayeeContact;
}

// ---------------------------------------------------------------------------
// Classifications (Money) -> tags (Monize)
// ---------------------------------------------------------------------------

/**
 * One classification item, as the Monize tag it becomes. Money's classification
 * is the tag's key and the item its value (`Properties:20 Spring Apartment`),
 * which is the `key:value` convention `tag-key-value.util.ts` already reads, so
 * the imported tags group under the classification they came from.
 */
export interface MappedTag {
  /** `CAT.hcat` of the classification item. */
  readonly handle: number;
  /** Tag name Monize will use, within the `tags.name` column width. */
  readonly name: string;
}

export interface MappedTags {
  /** Unique by name (case-insensitively), referenced items only. */
  readonly tags: readonly MappedTag[];
  /** Every referenced item handle that maps to a tag. */
  readonly byHandle: ReadonlyMap<number, MappedTag>;
  /** Classification items the file defines, referenced or not. */
  readonly inFile: number;
  /** Items no imported row references, so no tag is created for them. */
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

export interface MappedPayees {
  /** Unique by name, since `payees` is unique on `(user_id, name)`. */
  readonly payees: readonly MappedPayee[];
  readonly nameByHandle: ReadonlyMap<number, string>;
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export interface MappedSplit {
  /**
   * Pre-generated UUID, for the same reason a transaction has one: an
   * INVESTMENT leg's embedded investment row references the split through
   * `transaction_split_id` and both are inserted before either is read back.
   */
  readonly id: string;
  readonly kind: SplitKind;
  /**
   * Money `hcat` for a category split; for a transfer split, the category of
   * the row it links (one category per transfer, INV-CATEGORY-002); null for
   * an investment split.
   */
  readonly categoryHandle: number | null;
  /** Account key for a transfer split -- the loan or destination account. */
  readonly transferAccountKey: string | null;
  /**
   * The counterpart transaction of a transfer split. Pre-generated, so the
   * split is wired before either row is inserted.
   */
  readonly linkedTransactionId: string | null;
  /**
   * `TRN.htrn` of the investment row an INVESTMENT leg embeds; null on every
   * other kind. The leg's `amount` is that trade's cash impact, so the trade
   * writes no cash row of its own.
   */
  readonly investmentHandle: number | null;
  readonly amount: number;
  readonly memo: string | null;
  /** Classification items (`CAT.hcat`) the leg carries, written as split tags. */
  readonly tagHandles: readonly number[];
}

export interface MappedTransaction {
  /** Pre-generated UUID: transfer pairs and splits reference it before insert. */
  readonly id: string;
  /** `TRN.htrn`, for warnings and for pairing. */
  readonly handle: number;
  readonly accountKey: string;
  readonly transactionDate: string;
  readonly amount: number;
  readonly currencyCode: string;
  /**
   * Rate stored on the row: 1 for a row in its own account's currency, the
   * implied rate on a receiving cross-currency leg, `null` when the source
   * holds no rate and none can be derived (stored as no rate, never as 1).
   */
  readonly exchangeRate: number | null;
  /**
   * Date the row was reconciled. Absent means the writer's previous behaviour
   * (`null`).
   */
  readonly reconciledDate?: string | null;
  readonly status: TransactionStatus;
  readonly payeeHandle: number | null;
  readonly categoryHandle: number | null;
  readonly description: string | null;
  readonly referenceNumber: string | null;
  readonly isTransfer: boolean;
  /** The other side of a `TRN_XFER` pair. Exact -- never name-matched. */
  readonly linkedTransactionId: string | null;
  readonly splits: readonly MappedSplit[];
  /**
   * `TRN.htrn` of a trade whose cash this row records outright, having been
   * collapsed from the two-leg split Money wrote for it. Null everywhere else.
   * The trade adopts this row as its cash leg exactly as it adopts an external
   * funding row, and the interest leg is gone because the redemption's own
   * INTEREST companion records it.
   */
  readonly collapsedTradeHandle: number | null;
  /**
   * Classification items (`CAT.hcat`) the row carries in `TRN.lHcls1` /
   * `lHcls2`, written as the transaction's tags. Each side of a transfer
   * carries its own, exactly as Money records them.
   */
  readonly tagHandles: readonly number[];
}

export interface MappedTransactions {
  readonly transactions: readonly MappedTransaction[];
  /** Payee handles an imported transaction actually uses. */
  readonly referencedPayees: ReadonlySet<number>;
  /** Category handles an imported transaction or split actually uses. */
  readonly referencedCategories: ReadonlySet<number>;
  /** Classification item handles an imported transaction or split carries. */
  readonly referencedTags: ReadonlySet<number>;
  /**
   * Trade `TRN.htrn` -> the classification items on Money's own sleeve-side
   * cash row for that trade. Those rows are not imported (`writeInvestments`
   * writes the leg from the trade), so their tags move to the trade's leg.
   */
  readonly tradeCashLegTagHandles: ReadonlyMap<number, readonly number[]>;
  /** Transfer pairs fully linked in both directions. */
  readonly transfersLinked: number;
  /** `TRN` rows that are real postings but could not be imported. */
  readonly skipped: number;
  /**
   * Rows carrying a security, left for the investment mapper. Not a warning:
   * Phase 1 imports banking data and Phase 2 picks these up from the same
   * tables.
   */
  readonly deferredInvestments: number;
  /**
   * Money's own cash-sleeve rows for a trade in the paired brokerage account,
   * which the investment writer creates from the trade itself. Not skipped and
   * not lost: the row is written, from the other side. Reported because it is
   * the one number that says how much of a file went through that path, and it
   * has no other surface -- see `classifyTradeCashSides` (issue #1175).
   */
  readonly tradeCashLegs: number;
  /**
   * Where each trade's cash already sits, keyed by the investment row's
   * `TRN.htrn`. See `MnyInvestmentCashSource`: a trade named here must not
   * write a cash row of its own, because the banking side this mapper produced
   * *is* that row.
   */
  readonly investmentCashSources: ReadonlyMap<number, MnyInvestmentCashSource>;
  readonly warnings: readonly MnyWarning[];
}

/**
 * The banking row that already records one trade's cash movement.
 *
 * Money pairs a trade with the row that funds it through `TRN_XFER`, and that
 * row is a real posting in a real account -- a paycheque's investment leg, or a
 * purchase paid for out of a chequing account. Monize's own model has a place
 * for both shapes, so the pairing is honoured rather than turned into a
 * transfer into the brokerage's cash sleeve plus a second cash row leaving it
 * again (issues #1211 and #1212, the split and top-level halves of the same
 * defect).
 *
 * Exactly one of `transactionId` and `splitId` is set:
 *
 * - `transactionId` -- a top-level row in another account. It becomes the
 *   trade's cash leg (`investment_transactions.transaction_id`) and the trade
 *   records it as its `funding_account_id`, which is what a natively entered
 *   trade funded from elsewhere already stores.
 * - `splitId` -- a leg of a split transaction. The trade is embedded in that
 *   leg (`investment_transactions.transaction_split_id`) exactly as
 *   `createEmbeddedForSplit` writes a hand-entered one, and the leg's amount is
 *   the cash impact.
 */
export interface MnyInvestmentCashSource {
  /** Account key the cash actually moves in. */
  readonly accountKey: string;
  /** That account's currency, so a cross-currency trade can derive its rate. */
  readonly currencyCode: string;
  /** Signed amount the row or leg records, in `currencyCode`. */
  readonly amount: number;
  /**
   * The status of the transaction that carries it -- the funding row itself, or
   * the split's **parent**. The two rows describe one movement of money, so
   * they share the VOID boundary: a trade embedded in a voided split moves no
   * shares, exactly as `createEmbeddedForSplit` creates one with its parent's
   * status.
   */
  readonly status: TransactionStatus;
  /** The imported transaction that is the trade's cash leg, else null. */
  readonly transactionId: string | null;
  /** The imported split leg the trade is embedded in, else null. */
  readonly splitId: string | null;
}

/**
 * An investment row this import writes, as the transaction mapper needs to see
 * it: enough to tell a trade's cash side from an ordinary transfer, and no
 * more. Keyed by `TRN.htrn` in `MapTransactionsInput.tradesByHandle`.
 */
export interface MnyImportedTrade {
  /** The brokerage account key the shares land in. */
  readonly accountKey: string;
  readonly action: InvestmentAction;
  /** Signed cash the trade moves; 0 for the share-only actions. */
  readonly cashAmount: number;
  /**
   * Accrued interest riding on that cash (redemptions only, else 0). The
   * transaction mapper needs it to recognize the interest leg of the split
   * Money wrote, which is the leg the collapse removes.
   */
  readonly accruedInterest: number;
  /**
   * So a funding row adopted as this trade's cash leg cannot claim the money
   * moved when the trade says it did not. Only the VOID boundary is shared;
   * reconciliation states stay per-row.
   */
  readonly status: TransactionStatus;
}

// ---------------------------------------------------------------------------
// Securities and investments
// ---------------------------------------------------------------------------

export interface MappedSecurity {
  /** `SEC.hsec`. */
  readonly handle: number;
  /**
   * Symbol Monize will use: trimmed, unique within the import and within the
   * `securities` column width. Never shared with another security -- PR #192
   * upserted on `(user_id, symbol)` and collapsed distinct funds into one.
   */
  readonly symbol: string;
  /** Symbol as Money recorded it; empty when Money had none. */
  readonly moneySymbol: string;
  readonly name: string;
  readonly currencyCode: string;
  /**
   * Security type written to the row. Absent means the writer's previous
   * behaviour (`null`).
   */
  readonly securityType?: SecurityType | null;
  /**
   * True for a generated placeholder symbol, which no quote provider can
   * resolve. Matches the QIF importer's convention for auto-created securities.
   */
  readonly skipPriceUpdates: boolean;
}

export interface MappedSecurities {
  readonly securities: readonly MappedSecurity[];
  readonly byHandle: ReadonlyMap<number, MappedSecurity>;
  /** Currency pseudo-securities and rows with no usable identity. */
  readonly skipped: number;
  readonly warnings: readonly MnyWarning[];
}

export interface MappedInvestmentTransaction {
  /** Pre-generated UUID, so a share-transfer pair is wired before insert. */
  readonly id: string;
  /** `TRN.htrn`, or null for a `SEC_SPLIT`-derived SPLIT row. */
  readonly handle: number | null;
  /** The brokerage account key the shares move in. */
  readonly accountKey: string;
  /**
   * The account the cash moves in; null when the action moves no cash.
   *
   * Ordinarily the brokerage's own cash sleeve. When Money paired the trade
   * with a row in another account -- a purchase paid out of chequing, or a
   * paycheque's investment leg -- it is that account, and `cashTransactionId`
   * or `transactionSplitId` names the row already recording the movement.
   */
  readonly cashAccountKey: string | null;
  /**
   * The account a BUY draws its cash from (or a SELL pays into) when that is
   * not the brokerage's own sleeve -- `investment_transactions.funding_account_id`,
   * exactly as a natively entered trade funded from elsewhere stores it. Null
   * for a sleeve-funded trade and for one embedded in a split, matching
   * `createEmbeddedForSplit`.
   */
  readonly fundingAccountKey: string | null;
  /**
   * An already-imported transaction adopted as this trade's cash leg, instead
   * of the writer synthesizing one. Set only for issue #1212's shape: Money
   * recorded the cash in another account and that row is the movement.
   */
  readonly cashTransactionId: string | null;
  /**
   * The split leg this trade is embedded in (issue #1211). The leg carries the
   * cash impact, so no cash transaction is written for the trade at all.
   */
  readonly transactionSplitId: string | null;
  readonly securityHandle: number;
  readonly action: InvestmentAction;
  readonly transactionDate: string;
  /**
   * Always positive -- direction comes from `action`, never from a sign
   * (`TRN_INV.qty` is stored positive). For a SPLIT this is the ratio the
   * holdings fold multiplies by.
   */
  readonly quantity: number | null;
  readonly price: number | null;
  readonly commission: number;
  /**
   * Accrued interest Money recorded on the row (`TRN_INV.amtInt`), taken out of
   * `totalAmount`. Mapping-time metadata: it becomes the linked INTEREST
   * companion when the cash split collapses, or is cleared when a preserved
   * sibling split leg already records the interest. There is no column here.
   */
  readonly accruedInterest: number;
  /**
   * Positive magnitude of the transaction, in the security's currency; in the
   * account's currency when no exchange rate converted it, with a warning.
   */
  readonly totalAmount: number;
  /**
   * The cash/account currency the cash leg is written in. Not necessarily the
   * currency `price` and `totalAmount` are in; see `securityCurrencyCode`.
   */
  readonly currencyCode: string;
  /**
   * The currency `price`, `commission` and `totalAmount` are in: the security's
   * when the trade was converted, else the account's (`currencyCode`).
   */
  readonly securityCurrencyCode: string;
  /**
   * Converts `totalAmount` (security currency) into the cash account's
   * currency: security -> cash account. 1 only for a same-currency trade or one
   * left unconverted with a warning. A trade funded from an account in another
   * currency derives its rate from the two amounts Money recorded, because 1
   * there would post the cash unconverted.
   */
  readonly exchangeRate: number;
  /** Signed cash impact on the cash sleeve; 0 for the share-only actions. */
  readonly cashAmount: number;
  readonly status: TransactionStatus;
  readonly payeeHandle: number | null;
  readonly categoryHandle: number | null;
  readonly description: string | null;
  /**
   * The row this one is linked to: the other leg of an `act` 15/16 share
   * transfer, or a redemption's accrued-interest companion and back. Written to
   * `investment_transactions.linked_transaction_id` by the back-patch pass.
   */
  readonly linkedInvestmentId: string | null;
  /**
   * Classification items (`CAT.hcat`) the trade's cash leg carries when this
   * import writes that leg: the investment row's own, plus those of Money's
   * sleeve-side cash row it replaces (`adoptCashLegTags`).
   */
  readonly tagHandles: readonly number[];
}

export interface MappedInvestments {
  readonly transactions: readonly MappedInvestmentTransaction[];
  /** Security handles an imported investment row actually uses. */
  readonly referencedSecurities: ReadonlySet<number>;
  readonly referencedPayees: ReadonlySet<number>;
  readonly referencedCategories: ReadonlySet<number>;
  /** `act` 15/16 pairs turned into linked TRANSFER_IN / TRANSFER_OUT rows. */
  readonly transfersPaired: number;
  /** Security-carrying rows that could not be imported. */
  readonly skipped: number;
  /**
   * The pair and date of each trade left in its account's currency because
   * neither the file nor `MnyMarketRates` had a rate for it.
   */
  readonly rateGaps: readonly MnyRateGap[];
  readonly warnings: readonly MnyWarning[];
}

/**
 * A pair and date a cross-currency trade needs a rate for: `from` is the
 * security's currency, `to` the account's.
 */
export interface MnyRateGap {
  readonly from: string;
  readonly to: string;
  readonly date: string;
}

/** A market rate for one `MnyRateGap`, multiplying `from` into `to`. */
export interface MnyMarketRate extends MnyRateGap {
  readonly rate: number;
}

/**
 * Rates looked up outside the file for the trades it could not convert
 * (`MnyMarketRateService`): Monize's stored history, filled from the
 * configured rate provider.
 */
export interface MnyMarketRates {
  readonly rates: readonly MnyMarketRate[];
  /** `from->to` pairs whose lookup the rate provider did not answer. */
  readonly unanswered: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

/** One leg of a scheduled transaction built from a bill template's splits. */
export interface MappedBillSplit {
  readonly kind: SplitKind;
  /** Money `hcat` for a category leg; null for a transfer leg. */
  readonly categoryHandle: number | null;
  /** Account key a transfer leg pays into -- typically the loan account. */
  readonly transferAccountKey: string | null;
  readonly amount: number;
  readonly memo: string | null;
}

/** The investment template of a bill that schedules a recurring trade. */
export interface MappedBillInvestment {
  readonly action: InvestmentAction;
  readonly securityHandle: number;
  readonly quantity: number | null;
  readonly price: number | null;
  readonly commission: number;
}

/**
 * One detected-active bill series, ready to become a scheduled transaction.
 *
 * `handle` is the representative `BILL.hbill` and doubles as the wizard's
 * selection key (`options.bills`). Only detected-active series are mapped; the
 * checkbox list is the safety net for the detection being wrong in either
 * direction (design section 3, issue 2 -- 1,844 rows, ~20 real bills).
 */
export interface MappedBill {
  /** Representative `BILL.hbill`; the wizard's selection key. */
  readonly handle: number;
  /** `BILL.hbillHead`, or the row's own handle when the file has no series. */
  readonly seriesKey: number;
  /** Raw `BILL.st`, surfaced so real files can pin its semantics (question 12.3). */
  readonly status: number;
  /** Payee name, else the template's memo, else a generated fallback. */
  readonly name: string;
  readonly accountKey: string;
  readonly payeeHandle: number | null;
  /** Null when the bill is a transfer, an investment, or split. */
  readonly categoryHandle: number | null;
  readonly amount: number;
  readonly currencyCode: string;
  readonly frequency: FrequencyType;
  /**
   * Custom recurrence written to the schedule. Absent means the writer's
   * previous behaviour (`null`).
   */
  readonly customRecurrence?: CustomRecurrence | null;
  /** True when Monize cannot express the exact Money recurrence interval. */
  readonly approximate: boolean;
  readonly nextDueDate: string;
  readonly endDate: string | null;
  readonly description: string | null;
  readonly isTransfer: boolean;
  readonly transferAccountKey: string | null;
  readonly investment: MappedBillInvestment | null;
  readonly splits: readonly MappedBillSplit[];
  /** Classification items the template carries; the schedule's `tag_ids`. */
  readonly tagHandles: readonly number[];
}

export interface MappedBills {
  /** Detected-active candidates, one per series. */
  readonly bills: readonly MappedBill[];
  /** Distinct series seen in the file, active or not. */
  readonly seriesInFile: number;
  /** Series that could not be mapped at all (no template, no usable date). */
  readonly skipped: number;
  /** False for Money 2001 files, which predate the `BILL` table. */
  readonly supported: boolean;
  readonly warnings: readonly MnyWarning[];
}

// ---------------------------------------------------------------------------
// Loans
// ---------------------------------------------------------------------------

/**
 * What a loan or mortgage account's imported payments say about its terms.
 *
 * Money has no loan-terms table, so every field here is inferred from payment
 * shape and from the bill that pays the loan. A field the evidence does not
 * settle stays null and the writer leaves the account's own value alone.
 */
export interface MappedLoanTerms {
  readonly accountKey: string;
  /**
   * The category the payments book interest to, or null when the payments name
   * more than one non-principal category (a loan with an escrow leg does), in
   * which case escrow and interest cannot be told apart.
   */
  readonly interestCategoryHandle: number | null;
  /**
   * `SPLIT` when every observed payment booked interest as a split leg, which
   * is what `RateChangeInferenceService` needs so it does not also pair
   * standalone interest expenses and double-count. Null leaves the default.
   */
  readonly interestBookingMode: InterestBookingMode | null;
  /** Account key the payments came from -- the loan's funding account. */
  readonly sourceAccountKey: string | null;
  /** Scheduled installment, from the bill when there is one. */
  readonly paymentAmount: number | null;
  readonly paymentFrequency: FrequencyType | null;
  readonly paymentStartDate: string | null;
  /** Split-booked payments seen; 0 when the terms came only from a bill. */
  readonly paymentsObserved: number;
  /**
   * The loan's stated rates, ascending by date, the first one the
   * origination rate. Only a KMyMoney file states them (its `ir-YYYY-MM-DD`
   * KVPs, spec kmymoney-import 5.11); absent or empty writes no rate.
   */
  readonly rates?: readonly MappedLoanRate[];
  /** The amount originally borrowed, positive; absent or null writes none. */
  readonly originalPrincipal?: number | null;
  /** The whole life of the loan in months; absent or null writes none. */
  readonly amortizationMonths?: number | null;
}

/** One stated annual rate (percent) and the date it is effective from. */
export interface MappedLoanRate {
  /** YYYY-MM-DD. */
  readonly effectiveDate: string;
  readonly annualRate: number;
}

export interface MappedLoans {
  readonly loans: readonly MappedLoanTerms[];
  readonly warnings: readonly MnyWarning[];
}

/** One holding's line in the LOT cross-check (design task M2.3). */
export interface MnyHoldingCheck {
  readonly accountKey: string;
  readonly securityHandle: number;
  readonly symbol: string;
  /**
   * The file's own share count: Money's open lots, or KMyMoney's replay.
   * Shares open lots say the account holds (`LOT` rows with no `htrnSell`), or
   * the replay quantity for a security the file keeps no lot for at all -- CDs,
   * savings bonds and money-market funds, which Money records in `TRN_INV` but
   * tracks no tax lots for.
   */
  readonly lotQuantity: number;
  /** Shares replaying the mapped investment actions produces. */
  readonly replayQuantity: number;
  /** `replayQuantity - lotQuantity`. */
  readonly delta: number;
  readonly matches: boolean;
}

// ---------------------------------------------------------------------------
// Names too long for their column
// ---------------------------------------------------------------------------

/**
 * One file element whose name is longer than the Monize column it is written
 * to (issue #2313). The wizard offers a field to rename it; `options.renames`
 * carries the name the import uses, the shortened one unless the user chose.
 */
export interface MnyNameFix {
  readonly kind: MnyRenameKind;
  /** The element's ordinal within its section; the `MnyRename.handle`. */
  readonly handle: number;
  /** The name as the file has it, cut at `KMY_NAME_FIX_ORIGINAL_CHARS`. */
  readonly original: string;
  /** The whole name's length, in characters. */
  readonly originalLength: number;
  /** The most characters the name may have. */
  readonly maxLength: number;
}

export interface MnyNameFixes {
  /** At most `KMY_MAX_NAME_FIXES`, in file order by kind. */
  readonly entries: readonly MnyNameFix[];
  /** Too-long names beyond the cap: shortened, never listed. */
  readonly omitted: number;
}
