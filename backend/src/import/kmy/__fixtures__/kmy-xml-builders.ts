import { gzipSync } from "zlib";

/**
 * Test-only builders producing KMyMoney XML text. Option names are the XML
 * attribute names, so a spec reads like the file it describes. Nothing here
 * is added to `MNY_FIXTURES`: the KMyMoney registry is its own.
 */

export type KmyAttrs = Readonly<Record<string, string | number | undefined>>;
type Children = string | readonly string[] | undefined;

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;");
}

function joinChildren(children: Children): string {
  if (children === undefined) {
    return "";
  }
  return typeof children === "string" ? children : children.join("");
}

/** One element; `undefined` attributes are omitted, an empty body self-closes. */
export function kmyElement(
  name: string,
  attrs: KmyAttrs = {},
  children?: Children,
): string {
  const text = Object.entries(attrs)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` ${key}="${escapeAttr(String(value))}"`)
    .join("");
  const body = joinChildren(children);
  return body === ""
    ? `<${name}${text}/>`
    : `<${name}${text}>${body}</${name}>`;
}

function kvpElement(pairs: Readonly<Record<string, string>> | undefined) {
  const entries = Object.entries(pairs ?? {});
  return entries.length === 0
    ? ""
    : kmyElement(
        "KEYVALUEPAIRS",
        {},
        entries.map(([key, value]) => kmyElement("PAIR", { key, value })),
      );
}

export function kmyTxId(n: number): string {
  return `T${String(n).padStart(18, "0")}`;
}

export function kmyAccountId(n: number): string {
  return `A${String(n).padStart(6, "0")}`;
}

// ---------------------------------------------------------------------------

export interface KmyAccountExtras {
  kvp?: Readonly<Record<string, string>>;
  subaccounts?: readonly string[];
  reconciliations?: ReadonlyArray<{ date: string; value: string }>;
  /** Writes an ONLINEBANKING element with these attributes. */
  onlineBanking?: KmyAttrs;
  /** Raw child XML appended last. */
  extra?: string;
}

export function kmyAccount(
  overrides: KmyAttrs = {},
  extras: KmyAccountExtras = {},
): string {
  const attrs: KmyAttrs = {
    id: "A000001",
    parentaccount: "AStd::Asset",
    lastreconciled: "",
    lastmodified: "",
    institution: "",
    opened: "2024-01-01",
    number: "",
    type: 1,
    name: "Checking",
    description: "",
    currency: "USD",
    ...overrides,
  };
  const children = [
    extras.subaccounts && extras.subaccounts.length > 0
      ? kmyElement(
          "SUBACCOUNTS",
          {},
          extras.subaccounts.map((id) => kmyElement("SUBACCOUNT", { id })),
        )
      : "",
    extras.onlineBanking
      ? kmyElement("ONLINEBANKING", extras.onlineBanking)
      : "",
    extras.reconciliations && extras.reconciliations.length > 0
      ? kmyElement(
          "RECONCILIATIONS",
          {},
          extras.reconciliations.map((r) => kmyElement("RECONCILIATION", r)),
        )
      : "",
    kvpElement(extras.kvp),
    extras.extra ?? "",
  ];
  return kmyElement("ACCOUNT", attrs, children);
}

/** The five standard roots, always first in a KMyMoney file. */
export function kmyStandardAccounts(currency = "USD"): string[] {
  const roots: Array<[string, string, number]> = [
    ["AStd::Asset", "Asset", 9],
    ["AStd::Liability", "Liability", 10],
    ["AStd::Expense", "Expense", 13],
    ["AStd::Income", "Income", 12],
    ["AStd::Equity", "Equity", 16],
  ];
  return roots.map(([id, name, type]) =>
    kmyAccount({ id, name, type, parentaccount: "", opened: "", currency }),
  );
}

export function kmySplit(overrides: KmyAttrs = {}): string {
  return kmyElement("SPLIT", {
    id: "S0001",
    payee: "",
    reconciledate: "",
    action: "",
    reconcileflag: 0,
    value: "0/1",
    shares: "0/1",
    price: "1/1",
    memo: "",
    account: "A000001",
    number: "",
    bankid: "",
    ...overrides,
  });
}

/** A split with TAG children and/or KEYVALUEPAIRS. */
export function kmySplitWith(
  overrides: KmyAttrs,
  extras: { tags?: readonly string[]; kvp?: Readonly<Record<string, string>> },
): string {
  const open = kmySplit(overrides).replace(/\/>$/, ">");
  const children = [
    ...(extras.tags ?? []).map((id) => kmyElement("TAG", { id })),
    kvpElement(extras.kvp),
  ];
  return `${open}${children.join("")}</SPLIT>`;
}

export function kmyTransaction(
  splits: readonly string[],
  overrides: KmyAttrs = {},
  kvp?: Readonly<Record<string, string>>,
): string {
  return kmyElement(
    "TRANSACTION",
    {
      id: kmyTxId(1),
      postdate: "2024-01-05",
      memo: "",
      entrydate: "2024-01-05",
      commodity: "USD",
      ...overrides,
    },
    [kmyElement("SPLITS", {}, splits), kvpElement(kvp)],
  );
}

export function kmySchedule(
  templateSplits: readonly string[],
  overrides: KmyAttrs = {},
  template: KmyAttrs = {},
): string {
  return kmyElement(
    "SCHEDULED_TX",
    {
      id: "SCH000001",
      name: "Bill",
      type: 1,
      occurence: 32,
      occurenceMultiplier: 1,
      paymentType: 1,
      startDate: "2024-02-01",
      endDate: "",
      fixed: 0,
      lastDayInMonth: 0,
      autoEnter: 0,
      lastPayment: "2024-02-01",
      weekendOption: 1,
      ...overrides,
    },
    [
      kmyElement("PAYMENTS"),
      kmyElement(
        "TRANSACTION",
        {
          id: "",
          postdate: "2024-03-01",
          memo: "",
          entrydate: "",
          commodity: "USD",
          ...template,
        },
        kmyElement("SPLITS", {}, templateSplits),
      ),
    ],
  );
}

export function kmySecurity(
  overrides: KmyAttrs = {},
  kvp?: Readonly<Record<string, string>>,
): string {
  return kmyElement(
    "SECURITY",
    {
      id: "E000001",
      name: "Example Corp",
      symbol: "EXC",
      type: 0,
      "rounding-method": 7,
      saf: 1000,
      pp: 4,
      "trading-currency": "USD",
      "trading-market": "",
      ...overrides,
    },
    kvpElement(kvp),
  );
}

export function kmyCurrency(overrides: KmyAttrs = {}): string {
  return kmyElement("CURRENCY", {
    id: "USD",
    name: "US Dollar",
    symbol: "$",
    type: 3,
    "rounding-method": 7,
    saf: 100,
    pp: 4,
    scf: 100,
    ...overrides,
  });
}

/** One `PRICE` element. */
export function kmyPrice(overrides: KmyAttrs = {}): string {
  return kmyElement("PRICE", {
    date: "2024-02-10",
    price: "50/1",
    source: "Transaction",
    ...overrides,
  });
}

export function kmyPricePair(
  from: string,
  to: string,
  prices: readonly string[],
): string {
  return kmyElement("PRICEPAIR", { from, to }, prices);
}

export function kmyPayee(
  overrides: KmyAttrs = {},
  children?: Children,
): string {
  return kmyElement(
    "PAYEE",
    {
      id: "P000001",
      name: "Corner Market",
      reference: "",
      email: "",
      matchingenabled: 0,
      ...overrides,
    },
    children,
  );
}

export function kmyTag(overrides: KmyAttrs = {}): string {
  return kmyElement("TAG", {
    id: "G000001",
    name: "household",
    closed: 0,
    ...overrides,
  });
}

export function kmyInstitution(
  overrides: KmyAttrs = {},
  accountIds: readonly string[] = [],
): string {
  return kmyElement(
    "INSTITUTION",
    {
      id: "I000001",
      name: "Example Bank",
      manager: "",
      sortcode: "",
      ...overrides,
    },
    kmyElement(
      "ACCOUNTIDS",
      {},
      accountIds.map((id) => kmyElement("ACCOUNTID", { id })),
    ),
  );
}

// ---------------------------------------------------------------------------

export interface KmyFileSections {
  /** Replaces the whole FILEINFO element. */
  fileInfo?: string;
  institutions?: readonly string[];
  payees?: readonly string[];
  costCenters?: readonly string[];
  tags?: readonly string[];
  /** Appended after the five standard roots (unless `standardAccounts` is false). */
  accounts?: readonly string[];
  standardAccounts?: boolean;
  transactions?: readonly string[];
  /** File-level KEYVALUEPAIRS; `kmm-baseCurrency` defaults to USD. */
  kvp?: Readonly<Record<string, string>>;
  schedules?: readonly string[];
  securities?: readonly string[];
  currencies?: readonly string[];
  prices?: readonly string[];
  reports?: readonly string[];
  budgets?: readonly string[];
  onlineJobs?: readonly string[];
  /** Raw XML placed just before the closing root tag. */
  tail?: string;
  /** Replaces the whole prologue (`<?xml ...?><!DOCTYPE ...>`). */
  prologue?: string;
}

const DEFAULT_FILE_INFO = [
  "<FILEINFO>",
  '<CREATION_DATE date="2024-01-01"/>',
  '<LAST_MODIFIED_DATE date="2024-05-01T12:00:00+00:00"/>',
  '<VERSION id="1"/>',
  '<FIXVERSION id="12"/>',
  '<APPVERSION id="synthetic"/>',
  "</FILEINFO>",
].join("");

function section(name: string, items: readonly string[] | undefined): string {
  return items === undefined ? "" : kmyElement(name, {}, items);
}

/** A whole document, sections in the writer's order. */
export function kmyFile(sections: KmyFileSections = {}): string {
  const accounts = [
    ...(sections.standardAccounts === false ? [] : kmyStandardAccounts()),
    ...(sections.accounts ?? []),
  ];
  return [
    sections.prologue ??
      '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE KMYMONEY-FILE>',
    "<KMYMONEY-FILE>",
    sections.fileInfo ?? DEFAULT_FILE_INFO,
    '<USER name="" email=""/>',
    section("INSTITUTIONS", sections.institutions ?? []),
    section("PAYEES", sections.payees ?? []),
    section("COSTCENTERS", sections.costCenters ?? []),
    section("TAGS", sections.tags ?? []),
    section("ACCOUNTS", accounts),
    section("TRANSACTIONS", sections.transactions ?? []),
    kvpElement({ "kmm-baseCurrency": "USD", ...sections.kvp }),
    section("SCHEDULES", sections.schedules ?? []),
    section("SECURITIES", sections.securities ?? []),
    section("CURRENCIES", sections.currencies ?? []),
    section("PRICES", sections.prices ?? []),
    section("REPORTS", sections.reports ?? []),
    section("BUDGETS", sections.budgets ?? []),
    section("ONLINEJOBS", sections.onlineJobs ?? []),
    sections.tail ?? "",
    "</KMYMONEY-FILE>",
    "",
  ].join("\n");
}

export function gzip(data: string | Buffer): Buffer {
  return gzipSync(typeof data === "string" ? Buffer.from(data, "utf8") : data);
}

/** The XML as uploaded bytes: gzip (a `.kmy`) or plain (a `.xml`). */
export function toKmyBytes(xml: string, container: "gzip" | "xml"): Buffer {
  return container === "gzip" ? gzip(xml) : Buffer.from(xml, "utf8");
}
