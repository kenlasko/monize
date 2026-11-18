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
  KmySplit,
  KmyTag,
  KmyTemplateSplit,
  KmyTemplateTransaction,
  KmyTransaction,
} from "../model/kmy-raw";
import type { KmyAttributes, KmyXmlEvents } from "./kmy-xml-tokenize";

/**
 * Builds the raw model from the tokenizer's open/close events. Elements are
 * dispatched by their full path, never by name, because ACCOUNT, PAYEE and TAG
 * recur inside REPORT and BUDGET with other meanings. Ordinals count the
 * elements of one section in document order before anything is filtered.
 */

const R = "KMYMONEY-FILE";
const STANDARD_PREFIX = "AStd::";
const MATCHED_TX_KEY = "kmm-matched-tx";
const DEFAULT_FIX_VERSION = 12;
const LEGACY_FIX_VERSION = 5;

// ---------------------------------------------------------------------------
// Attribute decoding (reference 3.2, 3.3)

/** `YYYY-MM-DD` that is a real calendar date, else null. */
export function readKmyDate(text: string | undefined): string | null {
  if (text === undefined) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    return null;
  }
  const [year, month, day] = [+match[1], +match[2], +match[3]];
  const probe = new Date(Date.UTC(year, month - 1, day));
  probe.setUTCFullYear(year);
  const real =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  return real ? text : null;
}

/** Attribute booleans: 1/0, on/off, true/false, yes/no, any case; else the default. */
export function readKmyBool(
  text: string | undefined,
  fallback: boolean,
): boolean {
  switch (text?.trim().toLowerCase()) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    case "0":
    case "off":
    case "false":
    case "no":
      return false;
    default:
      return fallback;
  }
}

/** An unsigned integer attribute; anything else is `fallback`. */
export function readKmyUint(
  text: string | undefined,
  fallback: number,
): number {
  if (text === undefined || !/^\d{1,15}$/.test(text.trim())) {
    return fallback;
  }
  return Number(text.trim());
}

function readUnsignedBigint(text: string | undefined): bigint {
  return text !== undefined && /^\d+$/.test(text.trim())
    ? BigInt(text.trim())
    : 0n;
}

function nonEmpty(text: string | undefined): string | null {
  return text === undefined || text === "" ? null : text;
}

function attr(attributes: KmyAttributes, name: string): string {
  return attributes[name] ?? "";
}

/** The fix version rule of reference 2.3 for a present FIXVERSION element. */
function readFixVersion(attributes: KmyAttributes): number {
  let version = readKmyUint(attributes.date, 0);
  if (version === 0) {
    const id = attributes.id;
    version =
      id === undefined || id === "" ? LEGACY_FIX_VERSION : readKmyUint(id, 0);
  }
  return version === 2 ? 3 : version;
}

// ---------------------------------------------------------------------------
// Builders

interface PayeeBuilder {
  ordinal: number;
  id: string;
  name: string;
  hasDetails: boolean;
}

interface InstitutionBuilder {
  ordinal: number;
  id: string;
  name: string;
  accountIds: string[];
}

interface AccountBuilder {
  ordinal: number;
  id: string;
  parentId: string | null;
  name: string;
  type: number;
  currency: string | null;
  institutionId: string | null;
  opened: string | null;
  lastReconciled: string | null;
  number: string;
  description: string;
  subaccountIds: string[];
  reconciliations: KmyReconciliation[];
  kvp: Map<string, string>;
  hasOnlineBanking: boolean;
}

interface SplitBuilder {
  account: string;
  payee: string | null;
  value: KmyAmount;
  shares: KmyAmount;
  price: Rational;
  action: string;
  reconcileFlag: number;
  reconcileDate: string | null;
  memo: string;
  number: string;
  bankId: string;
  costCenter: string | null;
  tags: string[];
  hasMatchedTransaction: boolean;
}

interface TransactionBuilder {
  ordinal: number;
  id: string;
  postDate: string | null;
  memo: string;
  commodity: string | null;
  splits: KmySplit[];
  kvp: Map<string, string>;
}

interface TemplateBuilder {
  postDate: string | null;
  memo: string;
  commodity: string | null;
  splits: KmyTemplateSplit[];
}

interface ScheduleBuilder {
  ordinal: number;
  attributes: KmyAttributes;
  payments: string[];
  template: TemplateBuilder | null;
}

interface SecurityBuilder {
  ordinal: number;
  attributes: KmyAttributes;
  kvp: Map<string, string>;
}

export class KmyRawCollector implements KmyXmlEvents {
  private fixVersion = DEFAULT_FIX_VERSION;
  private appVersion: string | null = null;
  private creationDate: string | null = null;
  private lastModified: string | null = null;
  private readonly fileKvp = new Map<string, string>();

  private readonly institutions: KmyInstitution[] = [];
  private readonly payees: KmyPayee[] = [];
  private readonly tags: KmyTag[] = [];
  private readonly costCenters: KmyCostCenter[] = [];
  private readonly accounts: KmyAccount[] = [];
  private readonly transactions: KmyTransaction[] = [];
  private readonly transactionIndex = new Map<string, number>();
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
        this.fileKvp.set(attr(attributes, "key"), attr(attributes, "value"));
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
        this.payee = {
          ordinal: ++this.payeeCount,
          id: attr(attributes, "id"),
          name: attr(attributes, "name"),
          hasDetails:
            ["email", "reference", "notes", "defaultaccountid"].some(
              (name) => attr(attributes, name) !== "",
            ) || readKmyUint(attributes.matchingenabled, 0) === 1,
        };
        break;
      case `${R}/PAYEES/PAYEE/ADDRESS`:
        if (this.payee && Object.values(attributes).some((v) => v !== "")) {
          this.payee.hasDetails = true;
        }
        break;
      case `${R}/PAYEES/PAYEE/payeeIdentifier`:
        if (this.payee) {
          this.payee.hasDetails = true;
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
    const real = new Set<string>();
    for (const account of this.accounts) {
      if (!account.isStandard) {
        real.add(account.id);
      }
    }
    const unknownAccount = (split: { account: string }): boolean =>
      !real.has(split.account);
    const dangling =
      this.transactions.some((tx) => tx.splits.some(unknownAccount)) ||
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
      baseCurrency: nonEmpty(this.fileKvp.get("kmm-baseCurrency")),
      institutions: this.institutions,
      payees: this.payees,
      tags: this.tags,
      costCenters: this.costCenters,
      accounts: this.accounts,
      transactions: this.transactions,
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
    const transaction: KmyTransaction = { ...builder };
    // Two transactions with one (postdate, id) collapse to the later (R6.1).
    const key = `${builder.postDate ?? ""}|${builder.id}`;
    const existing = this.transactionIndex.get(key);
    if (existing === undefined) {
      this.transactionIndex.set(key, this.transactions.length);
      this.transactions.push(transaction);
      return;
    }
    this.transactions[existing] = transaction;
    this.warn("duplicateTransactionId", builder.id, builder.ordinal);
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
