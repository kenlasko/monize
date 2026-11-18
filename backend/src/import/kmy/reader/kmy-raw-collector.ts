import { KmyCorruptFileError } from "../model/kmy-errors";
import { parseKmyNumber, ZERO } from "../model/kmy-rational";
import type { Rational } from "../model/kmy-rational";
import type {
  KmyAccount,
  KmyAmount,
  KmyCostCenter,
  KmyCounts,
  KmyCurrency,
  KmyFileInfo,
  KmyInstitution,
  KmyPayee,
  KmyPrice,
  KmyRawFile,
  KmyReaderWarning,
  KmyReconciliation,
  KmySchedule,
  KmySecurity,
  KmyTag,
  KmyTemplateTransaction,
  KmyTransaction,
} from "../model/kmy-raw";
import type {
  AccountBuilder,
  InstitutionBuilder,
  PayeeBuilder,
  ScheduleBuilder,
  SecurityBuilder,
  SplitBuilder,
  TransactionBuilder,
} from "./kmy-reader-builders";
import {
  attr,
  nonEmpty,
  readFixVersion,
  readKmyBool,
  readKmyDate,
  readKmyUint,
  readUnsignedBigint,
} from "./kmy-reader-values";
import { readPayee, readPayeeAddress } from "./kmy-reader-payee";
import type { KmyAttributes, KmyXmlEvents } from "./kmy-xml-tokenize";

/**
 * Builds the raw model from the tokenizer's open/close events. Elements are
 * dispatched by their full path, never by name, because ACCOUNT, PAYEE and TAG
 * recur inside REPORT and BUDGET with other meanings. Ordinals count the
 * elements of one section in document order before anything is filtered.
 */

const R = "KMYMONEY-FILE";
const STANDARD_PREFIX = "AStd::";
const BASE_CURRENCY_KEY = "kmm-baseCurrency";
const MATCHED_TX_KEY = "kmm-matched-tx";
const DEFAULT_FIX_VERSION = 12;

export class KmyRawCollector implements KmyXmlEvents {
  private fixVersion = DEFAULT_FIX_VERSION;
  private appVersion: string | null = null;
  private creationDate: string | null = null;
  private lastModified: string | null = null;
  /** `kmm-baseCurrency` from the file-level key/value pairs; the last wins. */
  private baseCurrencyKvp: string | undefined;

  private readonly institutions: KmyInstitution[] = [];
  private readonly payees: KmyPayee[] = [];
  private readonly tags: KmyTag[] = [];
  private readonly costCenters: KmyCostCenter[] = [];
  private readonly accounts: KmyAccount[] = [];
  private readonly transactions: KmyTransaction[] = [];
  private readonly schedules: KmySchedule[] = [];
  private readonly securities: KmySecurity[] = [];
  private readonly currencies: KmyCurrency[] = [];
  private readonly prices: KmyPrice[] = [];
  private readonly warnings: KmyReaderWarning[] = [];
  private readonly counts: KmyCounts = {
    reports: 0,
    budgets: 0,
    onlineJobs: 0,
    matchedTransactions: 0,
    onlineBankingAccounts: 0,
  };

  private institutionCount = 0;
  private payeeCount = 0;
  private tagCount = 0;
  private costCenterCount = 0;
  private accountCount = 0;
  private transactionCount = 0;
  private scheduleCount = 0;
  private securityCount = 0;
  private currencyCount = 0;
  private priceCount = 0;

  private institution: InstitutionBuilder | null = null;
  private payee: PayeeBuilder | null = null;
  private account: AccountBuilder | null = null;
  private transaction: TransactionBuilder | null = null;
  private schedule: ScheduleBuilder | null = null;
  private security: SecurityBuilder | null = null;
  private split: SplitBuilder | null = null;
  private pricePair: { from: string; to: string } | null = null;

  // ---- events -------------------------------------------------------------

  open(path: string, attributes: KmyAttributes): void {
    switch (path) {
      case `${R}/FILEINFO/CREATION_DATE`:
        this.creationDate = readKmyDate(attributes.date);
        break;
      case `${R}/FILEINFO/LAST_MODIFIED_DATE`:
        this.lastModified = nonEmpty(attributes.date);
        break;
      case `${R}/FILEINFO/FIXVERSION`:
        this.fixVersion = readFixVersion(attributes);
        break;
      case `${R}/FILEINFO/APPVERSION`:
        this.appVersion = nonEmpty(attributes.id);
        break;
      case `${R}/KEYVALUEPAIRS/PAIR`:
        if (attr(attributes, "key") === BASE_CURRENCY_KEY) {
          this.baseCurrencyKvp = attr(attributes, "value");
        }
        break;

      case `${R}/INSTITUTIONS/INSTITUTION`:
        this.institution = {
          ordinal: ++this.institutionCount,
          id: attr(attributes, "id"),
          name: attr(attributes, "name"),
          accountIds: [],
        };
        break;
      case `${R}/INSTITUTIONS/INSTITUTION/ACCOUNTIDS/ACCOUNTID`: {
        const id = attr(attributes, "id");
        if (this.institution && id !== "") {
          this.institution.accountIds.push(id);
        }
        break;
      }

      case `${R}/PAYEES/PAYEE`:
        this.payee = readPayee(++this.payeeCount, attributes);
        break;
      case `${R}/PAYEES/PAYEE/ADDRESS`:
        if (this.payee) {
          this.payee.address = readPayeeAddress(attributes);
        }
        break;
      case `${R}/PAYEES/PAYEE/payeeIdentifier`:
        if (this.payee) {
          this.payee.hasIdentifiers = true;
        }
        break;

      case `${R}/TAGS/TAG`:
        this.tags.push({
          ordinal: ++this.tagCount,
          id: attr(attributes, "id"),
          name: attr(attributes, "name"),
          closed: readKmyBool(attributes.closed, false),
        });
        break;
      case `${R}/COSTCENTERS/COSTCENTER`:
        this.costCenters.push({
          ordinal: ++this.costCenterCount,
          id: attr(attributes, "id"),
          name: attr(attributes, "name"),
        });
        break;

      case `${R}/ACCOUNTS/ACCOUNT`:
        this.account = {
          ordinal: ++this.accountCount,
          id: attr(attributes, "id"),
          parentId: nonEmpty(attributes.parentaccount),
          name: attr(attributes, "name"),
          type: readKmyUint(attributes.type, 0),
          currency: nonEmpty(attributes.currency),
          institutionId: nonEmpty(attributes.institution),
          opened: readKmyDate(attributes.opened),
          lastReconciled: readKmyDate(attributes.lastreconciled),
          number: attr(attributes, "number"),
          description: attr(attributes, "description"),
          subaccountIds: [],
          reconciliations: [],
          kvp: new Map(),
          hasOnlineBanking: false,
        };
        break;
      case `${R}/ACCOUNTS/ACCOUNT/SUBACCOUNTS/SUBACCOUNT`: {
        const id = attr(attributes, "id");
        if (this.account && id !== "") {
          this.account.subaccountIds.push(id);
        }
        break;
      }
      case `${R}/ACCOUNTS/ACCOUNT/RECONCILIATIONS/RECONCILIATION`:
        this.openReconciliation(attributes);
        break;
      case `${R}/ACCOUNTS/ACCOUNT/KEYVALUEPAIRS/PAIR`:
        this.account?.kvp.set(
          attr(attributes, "key"),
          attr(attributes, "value"),
        );
        break;
      case `${R}/ACCOUNTS/ACCOUNT/ONLINEBANKING`:
        // Sensitive: nothing but the fact is kept.
        if (this.account) {
          this.account.hasOnlineBanking = true;
        }
        break;

      case `${R}/TRANSACTIONS/TRANSACTION`:
        this.transaction = {
          ordinal: ++this.transactionCount,
          id: attr(attributes, "id"),
          postDate: readKmyDate(attributes.postdate),
          memo: attr(attributes, "memo"),
          commodity: nonEmpty(attributes.commodity),
          splits: [],
          kvp: new Map(),
        };
        break;
      case `${R}/TRANSACTIONS/TRANSACTION/KEYVALUEPAIRS/PAIR`:
        this.transaction?.kvp.set(
          attr(attributes, "key"),
          attr(attributes, "value"),
        );
        break;
      case `${R}/TRANSACTIONS/TRANSACTION/SPLITS/SPLIT`:
        this.split = this.readSplit(attributes, false);
        break;

      case `${R}/SCHEDULES/SCHEDULED_TX`:
        this.schedule = {
          ordinal: ++this.scheduleCount,
          attributes,
          payments: [],
          template: null,
        };
        break;
      case `${R}/SCHEDULES/SCHEDULED_TX/PAYMENTS`:
      case `${R}/SCHEDULES/SCHEDULED_TX/PAYMENTS/PAYMENT`: {
        const date = readKmyDate(attributes.date);
        if (this.schedule && date !== null) {
          this.schedule.payments.push(date);
        }
        break;
      }
      case `${R}/SCHEDULES/SCHEDULED_TX/TRANSACTION`:
        if (this.schedule) {
          // A valid entrydate means KMyMoney clears the post date (reference 2.4).
          const dated = readKmyDate(attributes.entrydate) === null;
          this.schedule.template = {
            postDate: dated ? readKmyDate(attributes.postdate) : null,
            memo: attr(attributes, "memo"),
            commodity: nonEmpty(attributes.commodity),
            splits: [],
          };
        }
        break;
      case `${R}/SCHEDULES/SCHEDULED_TX/TRANSACTION/SPLITS/SPLIT`:
        this.split = this.readSplit(attributes, true);
        break;

      case `${R}/TRANSACTIONS/TRANSACTION/SPLITS/SPLIT/TAG`:
      case `${R}/SCHEDULES/SCHEDULED_TX/TRANSACTION/SPLITS/SPLIT/TAG`: {
        const id = attr(attributes, "id");
        if (this.split && id !== "") {
          this.split.tags.push(id);
        }
        break;
      }
      case `${R}/TRANSACTIONS/TRANSACTION/SPLITS/SPLIT/KEYVALUEPAIRS/PAIR`:
      case `${R}/SCHEDULES/SCHEDULED_TX/TRANSACTION/SPLITS/SPLIT/KEYVALUEPAIRS/PAIR`:
        // The matched transaction is an escaped document: counted, never parsed.
        if (this.split && attr(attributes, "key") === MATCHED_TX_KEY) {
          this.split.hasMatchedTransaction = true;
          this.counts.matchedTransactions++;
        }
        break;

      case `${R}/SECURITIES/SECURITY`:
        this.security = {
          ordinal: ++this.securityCount,
          attributes,
          kvp: new Map(),
        };
        break;
      case `${R}/SECURITIES/SECURITY/KEYVALUEPAIRS/PAIR`:
        this.security?.kvp.set(
          attr(attributes, "key"),
          attr(attributes, "value"),
        );
        break;
      case `${R}/CURRENCIES/CURRENCY`:
        this.currencies.push(this.readCurrency(attributes));
        break;

      case `${R}/PRICES/PRICEPAIR`:
        this.pricePair = {
          from: attr(attributes, "from"),
          to: attr(attributes, "to"),
        };
        break;
      case `${R}/PRICES/PRICEPAIR/PRICE`:
        this.readPrice(attributes);
        break;

      case `${R}/REPORTS/REPORT`:
        this.counts.reports++;
        break;
      case `${R}/BUDGETS/BUDGET`:
        this.counts.budgets++;
        break;
      case `${R}/ONLINEJOBS/ONLINEJOB`:
        this.counts.onlineJobs++;
        break;
      default:
        // Unknown elements are skipped.
        break;
    }
  }

  close(path: string): void {
    switch (path) {
      case `${R}/INSTITUTIONS/INSTITUTION`:
        if (this.institution && this.institution.id !== "") {
          this.institutions.push(this.institution);
        }
        this.institution = null;
        break;
      case `${R}/PAYEES/PAYEE`:
        if (this.payee && this.payee.id !== "") {
          this.payees.push(this.payee);
        }
        this.payee = null;
        break;
      case `${R}/ACCOUNTS/ACCOUNT`:
        if (this.account) {
          this.closeAccount(this.account);
        }
        this.account = null;
        break;
      case `${R}/TRANSACTIONS/TRANSACTION/SPLITS/SPLIT`:
        this.closePostedSplit();
        break;
      case `${R}/TRANSACTIONS/TRANSACTION`:
        if (this.transaction) {
          this.closeTransaction(this.transaction);
        }
        this.transaction = null;
        break;
      case `${R}/SCHEDULES/SCHEDULED_TX/TRANSACTION/SPLITS/SPLIT`:
        this.closeTemplateSplit();
        break;
      case `${R}/SCHEDULES/SCHEDULED_TX`:
        if (this.schedule) {
          this.closeSchedule(this.schedule);
        }
        this.schedule = null;
        break;
      case `${R}/SECURITIES/SECURITY`:
        if (this.security) {
          this.closeSecurity(this.security);
        }
        this.security = null;
        break;
      case `${R}/PRICES/PRICEPAIR`:
        this.pricePair = null;
        break;
      default:
        break;
    }
  }

  // ---- results ------------------------------------------------------------

  finish(container: "gzip" | "xml"): KmyRawFile {
    const transactions = this.collapseDuplicateTransactions();
    const real = new Set<string>();
    for (const account of this.accounts) {
      if (!account.isStandard) {
        real.add(account.id);
      }
    }
    const unknownAccount = (split: { account: string }): boolean =>
      !real.has(split.account);
    const dangling =
      transactions.some((tx) => tx.splits.some(unknownAccount)) ||
      this.schedules.some((s) => s.template?.splits.some(unknownAccount));
    if (dangling) {
      throw new KmyCorruptFileError(
        "a split references an account that is not in the file",
      );
    }

    const fileInfo: KmyFileInfo = {
      container,
      fixVersion: this.fixVersion,
      appVersion: this.appVersion,
      creationDate: this.creationDate,
      lastModified: this.lastModified,
    };
    return {
      fileInfo,
      baseCurrency: nonEmpty(this.baseCurrencyKvp),
      institutions: this.institutions,
      payees: this.payees,
      tags: this.tags,
      costCenters: this.costCenters,
      accounts: this.accounts,
      transactions,
      schedules: this.schedules,
      securities: this.securities,
      currencies: this.currencies,
      prices: this.prices,
      counts: this.counts,
      readerWarnings: this.warnings,
    };
  }

  // ---- numbers ------------------------------------------------------------

  private warn(
    code: KmyReaderWarning["code"],
    subject: string,
    transactionOrdinal: number | null,
  ): void {
    this.warnings.push({ code, subject, transactionOrdinal });
  }

  /** A rational, or `"autoCalc"` where the caller allows it; invalid reads as 0. */
  private amount(
    text: string,
    subject: string,
    allowAutoCalc: boolean,
  ): KmyAmount {
    const parsed = parseKmyNumber(text);
    if (parsed.kind === "value") {
      return parsed.value;
    }
    const ordinal = this.transaction?.ordinal ?? null;
    if (parsed.kind === "autoCalc") {
      if (allowAutoCalc) {
        return "autoCalc";
      }
      this.warn("autoCalcInPostedSplit", subject, ordinal);
      return ZERO;
    }
    this.warn("unparsableNumber", subject, ordinal);
    return ZERO;
  }

  private plain(text: string, subject: string): Rational {
    const value = this.amount(text, subject, false);
    return value === "autoCalc" ? ZERO : value;
  }

  // ---- elements -----------------------------------------------------------

  private openReconciliation(attributes: KmyAttributes): void {
    const date = readKmyDate(attributes.date);
    if (!this.account || date === null) {
      return;
    }
    this.account.reconciliations.push({
      date,
      value: this.plain(attr(attributes, "value"), "RECONCILIATION@value"),
    });
  }

  private closeAccount(builder: AccountBuilder): void {
    if (builder.id === "") {
      return;
    }
    const kvp = new Map(builder.kvp);
    // Legacy IBAN folds into iban (iban wins); lastStatementDate is obsolete.
    const legacyIban = kvp.get("IBAN");
    if (legacyIban !== undefined) {
      if (!kvp.has("iban")) {
        kvp.set("iban", legacyIban);
      }
      kvp.delete("IBAN");
    }
    kvp.delete("lastStatementDate");

    let reconciliations = builder.reconciliations;
    const history = kvp.get("reconciliationHistory");
    if (reconciliations.length === 0 && history) {
      reconciliations = this.readReconciliationHistory(history);
    }
    if (builder.hasOnlineBanking) {
      this.counts.onlineBankingAccounts++;
    }
    this.accounts.push({
      ordinal: builder.ordinal,
      id: builder.id,
      isStandard: builder.id.startsWith(STANDARD_PREFIX),
      parentId: builder.parentId,
      name: builder.name,
      type: builder.type,
      currency: builder.currency,
      institutionId: builder.institutionId,
      opened: builder.opened,
      lastReconciled: builder.lastReconciled,
      number: builder.number,
      description: builder.description,
      subaccountIds: builder.subaccountIds,
      reconciliations,
      kvp,
      hasOnlineBanking: builder.hasOnlineBanking,
    });
  }

  /** The legacy `date:value;date:value` form, used only when no element exists. */
  private readReconciliationHistory(history: string): KmyReconciliation[] {
    const entries: KmyReconciliation[] = [];
    for (const part of history.split(";")) {
      const at = part.indexOf(":");
      const date = readKmyDate(at < 0 ? undefined : part.slice(0, at));
      const parsed = at < 0 ? null : parseKmyNumber(part.slice(at + 1));
      if (date !== null && parsed?.kind === "value") {
        entries.push({ date, value: parsed.value });
      }
    }
    return entries;
  }

  private readSplit(
    attributes: KmyAttributes,
    template: boolean,
  ): SplitBuilder {
    const subject = (name: string) => `SPLIT@${name}`;
    return {
      account: attr(attributes, "account"),
      payee: nonEmpty(attributes.payee),
      value: this.amount(attr(attributes, "value"), subject("value"), template),
      shares: this.amount(
        attr(attributes, "shares"),
        subject("shares"),
        template,
      ),
      price: this.plain(attr(attributes, "price"), subject("price")),
      action: attr(attributes, "action"),
      reconcileFlag: readKmyUint(attributes.reconcileflag, 0),
      reconcileDate: readKmyDate(attributes.reconciledate),
      memo: attr(attributes, "memo"),
      number: attr(attributes, "number"),
      bankId: attr(attributes, "bankid"),
      costCenter: nonEmpty(attributes.costcenter),
      tags: [],
      hasMatchedTransaction: false,
    };
  }

  private takeSplit(): SplitBuilder | null {
    const split = this.split;
    this.split = null;
    // A split with an empty account is dropped by KMyMoney's reader.
    return split && split.account !== "" ? split : null;
  }

  private closePostedSplit(): void {
    const builder = this.takeSplit();
    const transaction = this.transaction;
    if (!builder || !transaction) {
      return;
    }
    const { value, shares } = builder;
    if (value === "autoCalc" || shares === "autoCalc") {
      return;
    }
    if (
      value.num !== 0n &&
      shares.num !== 0n &&
      value.num < 0n !== shares.num < 0n
    ) {
      throw new KmyCorruptFileError(
        "a split's shares and value have opposite signs",
      );
    }
    transaction.splits.push({
      ...builder,
      ordinal: transaction.splits.length + 1,
      value,
      shares,
    });
  }

  private closeTemplateSplit(): void {
    const builder = this.takeSplit();
    const template = this.schedule?.template;
    if (!builder || !template) {
      return;
    }
    const { value, shares } = builder;
    if (
      value !== "autoCalc" &&
      shares !== "autoCalc" &&
      value.num !== 0n &&
      shares.num !== 0n &&
      value.num < 0n !== shares.num < 0n
    ) {
      throw new KmyCorruptFileError(
        "a split's shares and value have opposite signs",
      );
    }
    template.splits.push({
      ...builder,
      ordinal: template.splits.length + 1,
    });
  }

  private closeTransaction(builder: TransactionBuilder): void {
    if (builder.id === "") {
      return;
    }
    this.transactions.push({ ...builder });
  }

  /**
   * Two transactions with one (postdate, id) collapse to the later one, at the
   * first one's position (R6.1). The index is local to this call, so no state
   * outlives the parse.
   */
  private collapseDuplicateTransactions(): KmyTransaction[] {
    const collapsed: KmyTransaction[] = [];
    const indexByKey = new Map<string, number>();
    for (const transaction of this.transactions) {
      const key = `${transaction.postDate ?? ""}|${transaction.id}`;
      const existing = indexByKey.get(key);
      if (existing === undefined) {
        indexByKey.set(key, collapsed.length);
        collapsed.push(transaction);
        continue;
      }
      collapsed[existing] = transaction;
      this.warn("duplicateTransactionId", transaction.id, transaction.ordinal);
    }
    return collapsed;
  }

  private closeSchedule(builder: ScheduleBuilder): void {
    const a = builder.attributes;
    const id = attr(a, "id");
    if (id === "") {
      return;
    }
    const template: KmyTemplateTransaction | null = builder.template;
    this.schedules.push({
      ordinal: builder.ordinal,
      id,
      name: attr(a, "name"),
      type: readKmyUint(a.type, 0),
      occurrence: readKmyUint(a.occurence, 0),
      multiplier: readKmyUint(a.occurenceMultiplier, 1),
      paymentType: readKmyUint(a.paymentType, 0),
      startDate: readKmyDate(a.startDate),
      endDate: readKmyDate(a.endDate),
      lastPayment: readKmyDate(a.lastPayment),
      fixed: readKmyBool(a.fixed, false),
      autoEnter: readKmyBool(a.autoEnter, false),
      lastDayInMonth: readKmyBool(a.lastDayInMonth, false),
      weekendOption: readKmyUint(a.weekendOption, 0),
      payments: builder.payments,
      template,
    });
  }

  private closeSecurity(builder: SecurityBuilder): void {
    const a = builder.attributes;
    const id = attr(a, "id");
    if (id === "") {
      return;
    }
    const pp = readKmyUint(a.pp, 0);
    const saf = readUnsignedBigint(a.saf);
    this.securities.push({
      ordinal: builder.ordinal,
      id,
      name: attr(a, "name"),
      symbol: attr(a, "symbol"),
      type: readKmyUint(a.type, 0),
      saf: saf === 0n ? 100n : saf,
      pp: pp === 0 || pp > 10 ? 4 : pp,
      roundingMethod: readKmyUint(a["rounding-method"], 0),
      tradingCurrency: nonEmpty(a["trading-currency"]),
      tradingMarket: attr(a, "trading-market"),
      kvp: builder.kvp,
    });
  }

  private readCurrency(a: KmyAttributes): KmyCurrency {
    const pp = readKmyUint(a.pp, 0);
    const saf = readUnsignedBigint(a.saf);
    const scf = readUnsignedBigint(a.scf);
    return {
      ordinal: ++this.currencyCount,
      id: attr(a, "id"),
      name: attr(a, "name"),
      symbol: attr(a, "symbol"),
      saf: saf === 0n ? 100n : saf,
      scf: scf === 0n ? 100n : scf,
      pp: pp === 0 || pp > 10 ? 4 : pp,
      roundingMethod: readKmyUint(a["rounding-method"], 0),
    };
  }

  private readPrice(a: KmyAttributes): void {
    const ordinal = ++this.priceCount;
    const date = readKmyDate(a.date);
    if (!this.pricePair || date === null) {
      return;
    }
    this.prices.push({
      ordinal,
      from: this.pricePair.from,
      to: this.pricePair.to,
      date,
      price: this.plain(attr(a, "price"), "PRICE@price"),
      source: attr(a, "source"),
    });
  }
}
