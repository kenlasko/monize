/**
 * QIF (Quicken Interchange Format) Parser
 *
 * QIF Format Reference:
 * - Lines starting with ! indicate record type
 * - ^ is record separator
 * - D = Date
 * - T = Amount
 * - P = Payee
 * - M = Memo
 * - N = Number (cheque number) OR Action (for investment transactions)
 * - C = Cleared status (* = cleared, X = reconciled)
 * - L = Category (transfers start with [])
 * - S = Split category
 * - E = Split memo
 * - $ = Split amount
 * - A = Address (multi-line)
 *
 * Investment-specific fields (!Type:Invst):
 * - Y = Security name/symbol
 * - I = Price per share
 * - Q = Quantity (number of shares)
 * - N = Action (Buy, Sell, Div, ReinvDiv, ShrsIn, ShrsOut, etc.)
 * - O = Commission
 */

export interface QifTransaction {
  date: string;
  amount: number;
  payee: string;
  memo: string;
  number: string;
  cleared: boolean;
  reconciled: boolean;
  category: string;
  tagNames?: string[];
  isTransfer: boolean;
  transferAccount: string;
  splits: QifSplit[];
  // Investment-specific fields
  security: string;
  action: string;
  price: number;
  quantity: number;
  commission: number;
}

export interface QifSplit {
  category: string;
  tagNames?: string[];
  memo: string;
  amount: number;
  isTransfer: boolean;
  transferAccount: string;
}

export interface QifParseResult {
  accountType: string;
  accountName: string;
  transactions: QifTransaction[];
  categories: string[];
  transferAccounts: string[];
  /** Unique securities found in investment transactions */
  securities: string[];
  detectedDateFormat: string;
  sampleDates: string[];
  /** Opening balance extracted from the first "Opening Balance" record, if present */
  openingBalance: number | null;
  /** Date of the opening balance record */
  openingBalanceDate: string | null;
}

export type DateFormat =
  | "MM/DD/YYYY"
  | "DD/MM/YYYY"
  | "YYYY-MM-DD"
  | "YYYY-DD-MM";

// Strip HTML angle brackets to prevent stored XSS from QIF content.
function stripHtml(value: string): string {
  return value.replace(/[<>]/g, "");
}

// Truncate a string to a maximum length to match database column limits.
function truncate(value: string, maxLength: number): string {
  const sanitized = stripHtml(value);
  return sanitized.length > maxLength
    ? sanitized.substring(0, maxLength)
    : sanitized;
}

// Field length limits matching database column constraints
const FIELD_LIMITS = {
  PAYEE: 255, // transaction.payee_name VARCHAR(255), payee.name VARCHAR(255)
  MEMO: 5000, // transaction.description TEXT (capped for safety)
  REFERENCE_NUMBER: 100, // transaction.reference_number VARCHAR(100)
  CATEGORY: 255, // category.name VARCHAR(255)
  SECURITY: 255, // security.name VARCHAR(255)
} as const;

export function parseQif(
  content: string,
  dateFormat?: DateFormat,
): QifParseResult {
  const lines = content.split(/\r?\n/);
  const transactions: QifTransaction[] = [];
  const categoriesSet = new Set<string>();
  const transferAccountsSet = new Set<string>();
  const securitiesSet = new Set<string>();
  const rawDates: string[] = [];
  const transactionRawDates: string[] = [];
  let openingBalanceRawDate: string | null = null;

  let accountType = "Bank";
  let accountName = "";
  let currentTransaction: Partial<QifTransaction> | null = null;
  let currentSplits: QifSplit[] = [];
  let currentSplit: Partial<QifSplit> | null = null;
  let openingBalance: number | null = null;
  let openingBalanceDate: string | null = null;
  let skippingSection = false;
  let inAccountSection = false;

  for (const line of lines) {
    if (!line.trim()) continue;

    const code = line[0];
    const value = line.slice(1).trim();

    // Account type headers
    if (line.startsWith("!Type:")) {
      const type = line.slice(6).trim();
      switch (type.toLowerCase()) {
        case "bank":
          accountType = "CHEQUING";
          skippingSection = false;
          break;
        case "cash":
          accountType = "CASH";
          skippingSection = false;
          break;
        case "ccard":
          accountType = "CREDIT_CARD";
          skippingSection = false;
          break;
        case "invst":
          accountType = "INVESTMENT";
          skippingSection = false;
          break;
        case "oth a":
          accountType = "ASSET";
          skippingSection = false;
          break;
        case "oth l":
          accountType = "LINE_OF_CREDIT";
          skippingSection = false;
          break;
        default: {
          // Known non-transaction sections: skip all lines until next transaction type
          const nonTransactionSections = [
            "cat",
            "class",
            "tag",
            "memorized",
            "security",
            "prices",
            "budget",
            "invitem",
            "template",
          ];
          if (nonTransactionSections.includes(type.toLowerCase())) {
            skippingSection = true;
          } else {
            // Truly unknown type: treat as OTHER but still parse transactions
            accountType = "OTHER";
            skippingSection = false;
          }
        }
      }
      continue;
    }

    // Account section: extract account name and type
    if (line.startsWith("!Account")) {
      inAccountSection = true;
      skippingSection = false;
      continue;
    }

    // Parse !Account section fields (N=name, T=type, ^=end)
    if (inAccountSection) {
      if (code === "N") {
        accountName = value;
      } else if (code === "T") {
        // Use account type from !Account only as fallback
        const accountSectionType = value.toLowerCase();
        const typeMap: Record<string, string> = {
          bank: "CHEQUING",
          cash: "CASH",
          ccard: "CREDIT_CARD",
          invst: "INVESTMENT",
          "oth a": "ASSET",
          "oth l": "LINE_OF_CREDIT",
        };
        if (typeMap[accountSectionType]) {
          accountType = typeMap[accountSectionType];
        }
      } else if (code === "^") {
        inAccountSection = false;
      }
      continue;
    }

    // Skip lines in non-transaction sections (e.g., !Type:Cat, !Type:Memorized)
    if (skippingSection) continue;

    // Start new transaction
    if (code === "D" && !currentTransaction) {
      currentTransaction = {
        date: "",
        amount: 0,
        payee: "",
        memo: "",
        number: "",
        cleared: false,
        reconciled: false,
        category: "",
        tagNames: [],
        isTransfer: false,
        transferAccount: "",
        splits: [],
        // Investment-specific fields
        security: "",
        action: "",
        price: 0,
        quantity: 0,
        commission: 0,
      };
      currentSplits = [];
      currentSplit = null;
    }

    if (!currentTransaction) continue;

    switch (code) {
      case "D": // Date
        rawDates.push(value);
        currentTransaction.date = parseQifDate(value, dateFormat);
        break;

      case "T": // Amount
      case "U": // Amount (alternative)
        currentTransaction.amount = parseQifAmount(value) ?? 0;
        break;

      case "P": // Payee
        currentTransaction.payee = truncate(value, FIELD_LIMITS.PAYEE);
        break;

      case "M": // Memo
        currentTransaction.memo = truncate(value, FIELD_LIMITS.MEMO);
        break;

      case "N": // Number (cheque number) OR Action (for investment transactions)
        currentTransaction.number = truncate(
          value,
          FIELD_LIMITS.REFERENCE_NUMBER,
        );
        // For investment transactions, N is the action (Buy, Sell, Div, etc.)
        currentTransaction.action = value;
        break;

      case "C": // Cleared status (* = cleared, X = reconciled)
        if (value === "*") {
          currentTransaction.cleared = true;
        } else if (value === "X" || value === "x") {
          currentTransaction.reconciled = true;
        }
        break;

      case "L": {
        // Category or Transfer (tags appended after / separator)
        const { category, tagNames, isTransfer, transferAccount } =
          parseCategoryOrTransfer(value);
        currentTransaction.category = truncate(category, FIELD_LIMITS.CATEGORY);
        currentTransaction.tagNames = tagNames;
        currentTransaction.isTransfer = isTransfer;
        currentTransaction.transferAccount = truncate(
          transferAccount,
          FIELD_LIMITS.CATEGORY,
        );

        if (isTransfer) {
          transferAccountsSet.add(
            truncate(transferAccount, FIELD_LIMITS.CATEGORY),
          );
        } else if (category) {
          categoriesSet.add(truncate(category, FIELD_LIMITS.CATEGORY));
        }
        break;
      }

      case "S": {
        // Split category (tags appended after / separator)
        // Save previous split if exists
        if (currentSplit && currentSplit.category !== undefined) {
          currentSplits.push(currentSplit as QifSplit);
        }

        const splitParsed = parseCategoryOrTransfer(value);
        currentSplit = {
          category: truncate(splitParsed.category, FIELD_LIMITS.CATEGORY),
          tagNames: splitParsed.tagNames,
          memo: "",
          amount: 0,
          isTransfer: splitParsed.isTransfer,
          transferAccount: truncate(
            splitParsed.transferAccount,
            FIELD_LIMITS.CATEGORY,
          ),
        };

        if (splitParsed.isTransfer) {
          transferAccountsSet.add(
            truncate(splitParsed.transferAccount, FIELD_LIMITS.CATEGORY),
          );
        } else if (splitParsed.category) {
          categoriesSet.add(
            truncate(splitParsed.category, FIELD_LIMITS.CATEGORY),
          );
        }
        break;
      }

      case "E": // Split memo
        if (currentSplit) {
          currentSplit.memo = truncate(value, FIELD_LIMITS.MEMO);
        }
        break;

      case "$": // Split amount
        if (currentSplit) {
          currentSplit.amount = parseQifAmount(value) ?? 0;
        }
        break;

      // Investment-specific fields
      case "Y": // Security name/symbol
        currentTransaction.security = truncate(value, FIELD_LIMITS.SECURITY);
        if (value) {
          securitiesSet.add(truncate(value, FIELD_LIMITS.SECURITY));
        }
        break;

      case "I": // Price per share
        currentTransaction.price = parseQifAmount(value) ?? 0;
        break;

      case "Q": // Quantity (number of shares)
        currentTransaction.quantity = parseQifAmount(value) ?? 0;
        break;

      case "O": // Commission
        currentTransaction.commission = parseQifAmount(value) ?? 0;
        break;

      case "^": // End of record
        // Save last split if exists
        if (currentSplit && currentSplit.category !== undefined) {
          currentSplits.push(currentSplit as QifSplit);
        }

        if (currentTransaction.date) {
          // Check if this is an Opening Balance record
          // Opening Balance records have Payee="Opening Balance" and typically a transfer category [AccountName]
          const isOpeningBalance =
            currentTransaction.payee?.toLowerCase() === "opening balance" ||
            (currentTransaction.isTransfer &&
              currentTransaction.payee
                ?.toLowerCase()
                .includes("opening balance"));

          if (isOpeningBalance && openingBalance === null) {
            // Extract opening balance - don't add as a transaction
            openingBalance = currentTransaction.amount || 0;
            openingBalanceDate = currentTransaction.date;
            openingBalanceRawDate = rawDates[rawDates.length - 1];
          } else {
            currentTransaction.splits = currentSplits;
            transactions.push(currentTransaction as QifTransaction);
            transactionRawDates.push(rawDates[rawDates.length - 1]);
          }
        }

        currentTransaction = null;
        currentSplits = [];
        currentSplit = null;
        break;
    }
  }

  // Handle last transaction if file doesn't end with ^
  if (currentTransaction && currentTransaction.date) {
    if (currentSplit && currentSplit.category !== undefined) {
      currentSplits.push(currentSplit as QifSplit);
    }
    currentTransaction.splits = currentSplits;
    transactions.push(currentTransaction as QifTransaction);
    transactionRawDates.push(rawDates[rawDates.length - 1]);
  }

  // Detect date format from raw dates
  const detectedDateFormat = dateFormat || detectDateFormat(rawDates);

  // If no explicit format was provided, re-parse all dates using the detected format
  // so the preview endpoint returns correct date ranges
  if (!dateFormat) {
    for (let i = 0; i < transactions.length; i++) {
      transactions[i].date = parseQifDate(
        transactionRawDates[i],
        detectedDateFormat,
      );
    }
    if (openingBalanceRawDate !== null) {
      openingBalanceDate = parseQifDate(
        openingBalanceRawDate,
        detectedDateFormat,
      );
    }
  }

  // Get sample dates for UI display (unique, up to 3)
  const sampleDates = [...new Set(rawDates)].slice(0, 3);

  return {
    accountType,
    accountName,
    transactions,
    categories: Array.from(categoriesSet).sort(),
    transferAccounts: Array.from(transferAccountsSet).sort(),
    securities: Array.from(securitiesSet).sort(),
    detectedDateFormat,
    sampleDates,
    openingBalance,
    openingBalanceDate,
  };
}

function normalizeDateSeparators(dateStr: string): string {
  // Remove wrapping quotes and trim
  let normalized = dateStr.replace(/^['"]|['"]$/g, "").trim();
  // Normalize apostrophe/quote used as date separator to '/'
  // Handles formats like DD/MM'YYYY, M/D'YY, and M/D' Y (space-padded single-digit year)
  normalized = normalized.replace(/(\d)\s*['"]\s*(\d)/g, "$1/$2");
  // Strip spaces around date separators (Quicken pads single-digit days: "2/ 4/19")
  normalized = normalized.replace(/\s*([/-])\s*/g, "$1");
  return normalized;
}

function detectDateFormat(dates: string[]): DateFormat {
  if (dates.length === 0) return "MM/DD/YYYY";

  // Normalize separators so apostrophe formats (e.g. DD/MM'YYYY) are handled
  const normalizedDates = dates.map(normalizeDateSeparators);

  // Check for YYYY-MM-DD or YYYY-DD-MM format (ISO-like)
  const isoMatch = normalizedDates[0]?.match(
    /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/,
  );
  if (isoMatch) {
    const [, , part2, part3] = isoMatch;
    const p2 = parseInt(part2);
    const p3 = parseInt(part3);

    // If second part > 12, it's likely the day (YYYY-DD-MM)
    if (p2 > 12) return "YYYY-DD-MM";
    // If third part > 12, it's likely the day (YYYY-MM-DD)
    if (p3 > 12) return "YYYY-MM-DD";

    // Check all dates to disambiguate
    for (const date of normalizedDates) {
      const m = date.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (m) {
        if (parseInt(m[2]) > 12) return "YYYY-DD-MM";
        if (parseInt(m[3]) > 12) return "YYYY-MM-DD";
      }
    }

    // Default to YYYY-MM-DD for ISO-like formats
    return "YYYY-MM-DD";
  }

  // Check for MM/DD/YYYY or DD/MM/YYYY format
  for (const date of normalizedDates) {
    const match = date.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{1,4})$/);
    if (match) {
      const [, part1, part2] = match;
      const p1 = parseInt(part1);
      const p2 = parseInt(part2);

      // If first part > 12, it must be DD/MM/YYYY
      if (p1 > 12) return "DD/MM/YYYY";
      // If second part > 12, it must be MM/DD/YYYY
      if (p2 > 12) return "MM/DD/YYYY";
    }
  }

  // Default to MM/DD/YYYY (most common in QIF files)
  return "MM/DD/YYYY";
}

function parseQifDate(dateStr: string, format?: DateFormat): string {
  dateStr = normalizeDateSeparators(dateStr);

  // Try YYYY-MM-DD or YYYY-DD-MM format (ISO-like)
  let match = dateStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    const [, year, part2, part3] = match;

    let month: string, day: string;
    if (format === "YYYY-DD-MM") {
      day = part2.padStart(2, "0");
      month = part3.padStart(2, "0");
    } else {
      // Default to YYYY-MM-DD
      month = part2.padStart(2, "0");
      day = part3.padStart(2, "0");
    }

    return `${year}-${month}-${day}`;
  }

  // Try MM/DD/YYYY or DD/MM/YYYY format (1-4 digit years)
  match = dateStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{1,4})$/);
  if (match) {
    const [, part1, part2, yearRaw] = match;
    let year = yearRaw;

    // Convert 1 or 2-digit year to 4-digit
    if (year.length <= 2) {
      const yearNum = parseInt(year);
      year =
        yearNum > 50
          ? `19${year.padStart(2, "0")}`
          : `20${year.padStart(2, "0")}`;
    }

    let month: string, day: string;
    if (format === "DD/MM/YYYY") {
      day = part1.padStart(2, "0");
      month = part2.padStart(2, "0");
    } else {
      // Default to MM/DD/YYYY
      month = part1.padStart(2, "0");
      day = part2.padStart(2, "0");
    }

    return `${year}-${month}-${day}`;
  }

  // Return as-is if can't parse
  return dateStr;
}

function parseQifAmount(amountStr: string): number | null {
  // Remove currency symbols, spaces, and commas
  const cleaned = amountStr.replace(/[$£€,\s]/g, "");
  const amount = parseFloat(cleaned);
  return isNaN(amount) ? null : amount;
}

function parseCategoryOrTransfer(value: string): {
  category: string;
  tagNames: string[];
  isTransfer: boolean;
  transferAccount: string;
} {
  // Quicken uses "--Split--" as a placeholder for split transactions; treat as empty
  if (value.toLowerCase() === "--split--") {
    return {
      category: "",
      tagNames: [],
      isTransfer: false,
      transferAccount: "",
    };
  }

  // Transfers are denoted by [Account Name]
  // Tags can also appear on transfers: [Account Name]/TagName
  const transferMatch = value.match(/^\[(.+)\](.*)$/);
  if (transferMatch) {
    const tagNames = extractTagNames(transferMatch[2]);
    return {
      category: "",
      tagNames,
      isTransfer: true,
      transferAccount: transferMatch[1],
    };
  }

  // Category might have subcategory separated by :
  // Tags are appended after the category/subcategory separated by /
  // e.g., "Food:Groceries/TagA/TagB" or "Food/Tag" or just "Food"
  const { category, tagNames } = extractCategoryAndTags(value);
  return {
    category,
    tagNames,
    isTransfer: false,
    transferAccount: "",
  };
}

/**
 * Extract tag names from a string that starts with / separator.
 * Quicken separates tags with both / and : (colon) characters.
 * e.g., "/TagA/TagB" -> ["TagA", "TagB"]
 * e.g., "/TagA:TagB" -> ["TagA", "TagB"]
 * e.g., "/TagA:TagB/TagC" -> ["TagA", "TagB", "TagC"]
 * e.g., "" -> []
 */
function extractTagNames(suffix: string): string[] {
  if (!suffix) return [];
  // Split by / and : to handle both Quicken tag separator formats,
  // strip HTML for XSS safety
  return suffix
    .split(/[/:]/)
    .map((s) => stripHtml(s.trim()))
    .filter((s) => s.length > 0);
}

/**
 * Extract category and tag names from a QIF category field.
 * Tags are separated from the category by / (forward slash).
 * Multiple tags can be separated by / or : (Quicken uses both).
 * e.g., "Food:Groceries/TagA/TagB" -> { category: "Food:Groceries", tagNames: ["TagA", "TagB"] }
 * e.g., "Food:Groceries/TagA:TagB" -> { category: "Food:Groceries", tagNames: ["TagA", "TagB"] }
 * e.g., "Food/Tag" -> { category: "Food", tagNames: ["Tag"] }
 * e.g., "Food:Groceries" -> { category: "Food:Groceries", tagNames: [] }
 */
function extractCategoryAndTags(value: string): {
  category: string;
  tagNames: string[];
} {
  const slashIndex = value.indexOf("/");
  if (slashIndex === -1) {
    return { category: value, tagNames: [] };
  }

  const category = value.substring(0, slashIndex);
  const tagNames = extractTagNames(value.substring(slashIndex));
  return { category, tagNames };
}

// --- Multi-account QIF support ---

/**
 * A category definition parsed from a !Type:Cat section.
 */
export interface QifCategoryDef {
  name: string;
  description: string;
  isIncome: boolean;
  taxRelated: boolean;
  taxSchedule: string;
}

/**
 * A tag definition parsed from a !Type:Tag section.
 */
export interface QifTagDef {
  name: string;
  description: string;
}

/**
 * A block of transactions belonging to one account, parsed from
 * an !Account + !Type:xxx pair in a multi-account QIF file.
 */
export interface QifAccountBlock {
  accountName: string;
  accountType: string;
  description: string;
  creditLimit: number | null;
  transactions: QifTransaction[];
  categories: string[];
  transferAccounts: string[];
  securities: string[];
  openingBalance: number | null;
  openingBalanceDate: string | null;
}

/**
 * Full parse result for multi-account QIF files (Quicken full export).
 */
export interface QifFullParseResult {
  categoryDefs: QifCategoryDef[];
  tagDefs: QifTagDef[];
  accountBlocks: QifAccountBlock[];
  detectedDateFormat: DateFormat;
  sampleDates: string[];
  isMultiAccount: boolean;
}

/**
 * Detect whether a QIF file contains multiple accounts.
 * A file is multi-account if it has multiple !Account sections
 * or a !Type:Cat section (Quicken full export indicator).
 */
export function isMultiAccountQif(content: string): boolean {
  const accountMatches = content.match(/^!Account$/gm);
  if (accountMatches && accountMatches.length > 1) return true;
  if (/^!Type:Cat\s*$/im.test(content)) return true;
  return false;
}

/**
 * Parse a multi-account QIF file (Quicken full export).
 * Extracts category definitions from !Type:Cat sections,
 * groups transactions by !Account blocks, and ignores
 * !Type:Class and !Type:Memorized sections.
 *
 * The existing parseQif() is intentionally left unchanged
 * to preserve Microsoft Money single-account import behavior.
 */
export function parseQifFull(
  content: string,
  dateFormat?: DateFormat,
): QifFullParseResult {
  const lines = content.split(/\r?\n/);
  const categoryDefs: QifCategoryDef[] = [];
  const tagDefs: QifTagDef[] = [];
  const accountBlocks: QifAccountBlock[] = [];
  const rawDates: string[] = [];

  // Current category definition being built
  let currentCatDef: Partial<QifCategoryDef> | null = null;

  // Current tag definition being built
  let currentTagDef: Partial<QifTagDef> | null = null;
  let inTagSection = false;

  // Current account block being built
  let currentBlock: QifAccountBlock | null = null;

  // Per-block state
  let currentTransaction: Partial<QifTransaction> | null = null;
  let currentSplits: QifSplit[] = [];
  let currentSplit: Partial<QifSplit> | null = null;
  let blockCategoriesSet = new Set<string>();
  let blockTransferAccountsSet = new Set<string>();
  let blockSecuritiesSet = new Set<string>();
  let blockOpeningBalance: number | null = null;
  let blockOpeningBalanceDate: string | null = null;
  let blockRawDates: string[] = [];
  let blockTransactionRawDates: string[] = [];

  let inCatSection = false;
  let inAccountSection = false;
  let skippingSection = false;
  let pendingAccountName = "";
  let pendingAccountType = "";
  let pendingAccountDesc = "";
  let pendingAccountLimit: number | null = null;

  function finalizeBlock(): void {
    if (!currentBlock) return;

    // Finalize last transaction if present
    if (currentTransaction && currentTransaction.date) {
      if (currentSplit && currentSplit.category !== undefined) {
        currentSplits.push(currentSplit as QifSplit);
      }

      const isOB =
        currentTransaction.payee?.toLowerCase() === "opening balance" ||
        (currentTransaction.isTransfer &&
          currentTransaction.payee?.toLowerCase().includes("opening balance"));

      if (isOB && blockOpeningBalance === null) {
        blockOpeningBalance = currentTransaction.amount || 0;
        blockOpeningBalanceDate = currentTransaction.date;
      } else {
        currentTransaction.splits = currentSplits;
        currentBlock.transactions.push(currentTransaction as QifTransaction);
        blockTransactionRawDates.push(blockRawDates[blockRawDates.length - 1]);
      }
    }

    currentBlock.categories = Array.from(blockCategoriesSet).sort();
    currentBlock.transferAccounts = Array.from(blockTransferAccountsSet).sort();
    currentBlock.securities = Array.from(blockSecuritiesSet).sort();
    currentBlock.openingBalance = blockOpeningBalance;
    currentBlock.openingBalanceDate = blockOpeningBalanceDate;
    accountBlocks.push(currentBlock);

    // Reset per-block state
    currentTransaction = null;
    currentSplits = [];
    currentSplit = null;
    blockCategoriesSet = new Set();
    blockTransferAccountsSet = new Set();
    blockSecuritiesSet = new Set();
    blockOpeningBalance = null;
    blockOpeningBalanceDate = null;
    blockRawDates = [];
    blockTransactionRawDates = [];
  }

  for (const line of lines) {
    if (!line.trim()) continue;

    const code = line[0];
    const value = line.slice(1).trim();

    // Ignore AutoSwitch directives
    if (
      line.startsWith("!Option:AutoSwitch") ||
      line.startsWith("!Clear:AutoSwitch")
    ) {
      continue;
    }

    // --- Section headers (must be checked before inCatSection/inAccountSection) ---

    // Any !Type: or !Account header exits the current cat/account section
    if (line.startsWith("!Type:") || line.startsWith("!Account")) {
      // Flush pending category def if we were in a cat section
      if (inCatSection && currentCatDef && currentCatDef.name) {
        categoryDefs.push({
          name: truncate(currentCatDef.name, FIELD_LIMITS.CATEGORY),
          description: currentCatDef.description || "",
          isIncome: currentCatDef.isIncome || false,
          taxRelated: currentCatDef.taxRelated || false,
          taxSchedule: currentCatDef.taxSchedule || "",
        });
        currentCatDef = null;
      }
      // Flush pending tag def if we were in a tag section
      if (inTagSection && currentTagDef && currentTagDef.name) {
        tagDefs.push({
          name: truncate(currentTagDef.name, FIELD_LIMITS.CATEGORY),
          description: currentTagDef.description || "",
        });
        currentTagDef = null;
      }
      inCatSection = false;
      inTagSection = false;
      inAccountSection = false;
      skippingSection = false;
    }

    // --- !Type:Cat section start ---
    if (/^!Type:Cat\s*$/i.test(line)) {
      inCatSection = true;
      currentCatDef = null;
      continue;
    }

    if (inCatSection) {
      if (code === "N") {
        // Start new category def (save previous if present)
        if (currentCatDef && currentCatDef.name) {
          categoryDefs.push({
            name: truncate(currentCatDef.name, FIELD_LIMITS.CATEGORY),
            description: currentCatDef.description || "",
            isIncome: currentCatDef.isIncome || false,
            taxRelated: currentCatDef.taxRelated || false,
            taxSchedule: currentCatDef.taxSchedule || "",
          });
        }
        currentCatDef = { name: stripHtml(value) };
      } else if (code === "D" && currentCatDef) {
        currentCatDef.description = stripHtml(value);
      } else if (code === "I" && currentCatDef) {
        currentCatDef.isIncome = true;
      } else if (code === "E" && currentCatDef) {
        currentCatDef.isIncome = false;
      } else if (code === "T" && currentCatDef) {
        currentCatDef.taxRelated = true;
      } else if (code === "R" && currentCatDef) {
        currentCatDef.taxSchedule = stripHtml(value);
      } else if (code === "^") {
        if (currentCatDef && currentCatDef.name) {
          categoryDefs.push({
            name: truncate(currentCatDef.name, FIELD_LIMITS.CATEGORY),
            description: currentCatDef.description || "",
            isIncome: currentCatDef.isIncome || false,
            taxRelated: currentCatDef.taxRelated || false,
            taxSchedule: currentCatDef.taxSchedule || "",
          });
        }
        currentCatDef = null;
      }
      continue;
    }

    // --- !Type:Tag section ---
    if (inTagSection) {
      if (code === "N") {
        // Start new tag def (save previous if present)
        if (currentTagDef && currentTagDef.name) {
          tagDefs.push({
            name: truncate(currentTagDef.name, FIELD_LIMITS.CATEGORY),
            description: currentTagDef.description || "",
          });
        }
        currentTagDef = { name: stripHtml(value) };
      } else if (code === "D" && currentTagDef) {
        currentTagDef.description = stripHtml(value);
      } else if (code === "^") {
        if (currentTagDef && currentTagDef.name) {
          tagDefs.push({
            name: truncate(currentTagDef.name, FIELD_LIMITS.CATEGORY),
            description: currentTagDef.description || "",
          });
        }
        currentTagDef = null;
      }
      continue;
    }

    // --- !Account section ---
    if (line.startsWith("!Account")) {
      // Finalize previous block if we were in one
      finalizeBlock();
      currentBlock = null;

      inAccountSection = true;
      pendingAccountName = "";
      pendingAccountType = "";
      pendingAccountDesc = "";
      pendingAccountLimit = null;
      continue;
    }

    if (inAccountSection) {
      if (code === "N") {
        pendingAccountName = truncate(value, FIELD_LIMITS.CATEGORY);
      } else if (code === "T") {
        const typeMap: Record<string, string> = {
          bank: "CHEQUING",
          cash: "CASH",
          ccard: "CREDIT_CARD",
          invst: "INVESTMENT",
          "oth a": "ASSET",
          "oth l": "LINE_OF_CREDIT",
        };
        pendingAccountType =
          typeMap[value.toLowerCase()] || value.toUpperCase();
      } else if (code === "D") {
        pendingAccountDesc = truncate(value, FIELD_LIMITS.MEMO);
      } else if (code === "L") {
        pendingAccountLimit = parseQifAmount(value);
      } else if (code === "^") {
        inAccountSection = false;
        // Don't create block yet; wait for !Type:xxx to confirm it's transactional
      }
      continue;
    }

    // --- !Type: headers ---
    if (line.startsWith("!Type:")) {
      const type = line.slice(6).trim().toLowerCase();
      const nonTransactionSections = [
        "cat",
        "class",
        "tag",
        "memorized",
        "security",
        "prices",
        "budget",
        "invitem",
        "template",
      ];

      if (nonTransactionSections.includes(type)) {
        if (type === "cat") {
          inCatSection = true;
        } else if (type === "tag") {
          inTagSection = true;
          currentTagDef = null;
        } else {
          skippingSection = true;
        }
        continue;
      }

      // Transaction-bearing type: create a new account block
      const typeMap: Record<string, string> = {
        bank: "CHEQUING",
        cash: "CASH",
        ccard: "CREDIT_CARD",
        invst: "INVESTMENT",
        "oth a": "ASSET",
        "oth l": "LINE_OF_CREDIT",
      };
      const resolvedType = typeMap[type] || pendingAccountType || "CHEQUING";

      // Finalize previous block if still open
      finalizeBlock();

      currentBlock = {
        accountName: pendingAccountName,
        accountType: resolvedType,
        description: pendingAccountDesc,
        creditLimit: pendingAccountLimit,
        transactions: [],
        categories: [],
        transferAccounts: [],
        securities: [],
        openingBalance: null,
        openingBalanceDate: null,
      };
      skippingSection = false;
      continue;
    }

    // Skip non-transaction sections
    if (skippingSection) continue;

    // --- Transaction fields (same logic as parseQif) ---
    if (!currentBlock) continue;

    // Start new transaction on D field
    if (code === "D" && !currentTransaction) {
      currentTransaction = {
        date: "",
        amount: 0,
        payee: "",
        memo: "",
        number: "",
        cleared: false,
        reconciled: false,
        category: "",
        tagNames: [],
        isTransfer: false,
        transferAccount: "",
        splits: [],
        security: "",
        action: "",
        price: 0,
        quantity: 0,
        commission: 0,
      };
      currentSplits = [];
      currentSplit = null;
    }

    if (!currentTransaction) continue;

    switch (code) {
      case "D":
        rawDates.push(value);
        blockRawDates.push(value);
        currentTransaction.date = parseQifDate(value, dateFormat);
        break;

      case "T":
      case "U":
        currentTransaction.amount = parseQifAmount(value) ?? 0;
        break;

      case "P":
        currentTransaction.payee = truncate(value, FIELD_LIMITS.PAYEE);
        break;

      case "M":
        currentTransaction.memo = truncate(value, FIELD_LIMITS.MEMO);
        break;

      case "N":
        currentTransaction.number = truncate(
          value,
          FIELD_LIMITS.REFERENCE_NUMBER,
        );
        currentTransaction.action = value;
        break;

      case "C":
        if (value === "*") {
          currentTransaction.cleared = true;
        } else if (value === "X" || value === "x") {
          currentTransaction.reconciled = true;
        }
        break;

      case "L": {
        const { category, tagNames, isTransfer, transferAccount } =
          parseCategoryOrTransfer(value);
        currentTransaction.category = truncate(category, FIELD_LIMITS.CATEGORY);
        currentTransaction.tagNames = tagNames;
        currentTransaction.isTransfer = isTransfer;
        currentTransaction.transferAccount = truncate(
          transferAccount,
          FIELD_LIMITS.CATEGORY,
        );

        if (isTransfer) {
          blockTransferAccountsSet.add(
            truncate(transferAccount, FIELD_LIMITS.CATEGORY),
          );
        } else if (category) {
          blockCategoriesSet.add(truncate(category, FIELD_LIMITS.CATEGORY));
        }
        break;
      }

      case "S": {
        if (currentSplit && currentSplit.category !== undefined) {
          currentSplits.push(currentSplit as QifSplit);
        }

        const splitParsed = parseCategoryOrTransfer(value);
        currentSplit = {
          category: truncate(splitParsed.category, FIELD_LIMITS.CATEGORY),
          tagNames: splitParsed.tagNames,
          memo: "",
          amount: 0,
          isTransfer: splitParsed.isTransfer,
          transferAccount: truncate(
            splitParsed.transferAccount,
            FIELD_LIMITS.CATEGORY,
          ),
        };

        if (splitParsed.isTransfer) {
          blockTransferAccountsSet.add(
            truncate(splitParsed.transferAccount, FIELD_LIMITS.CATEGORY),
          );
        } else if (splitParsed.category) {
          blockCategoriesSet.add(
            truncate(splitParsed.category, FIELD_LIMITS.CATEGORY),
          );
        }
        break;
      }

      case "E":
        if (currentSplit) {
          currentSplit.memo = truncate(value, FIELD_LIMITS.MEMO);
        }
        break;

      case "$":
        if (currentSplit) {
          currentSplit.amount = parseQifAmount(value) ?? 0;
        }
        break;

      case "Y":
        currentTransaction.security = truncate(value, FIELD_LIMITS.SECURITY);
        if (value) {
          blockSecuritiesSet.add(truncate(value, FIELD_LIMITS.SECURITY));
        }
        break;

      case "I":
        currentTransaction.price = parseQifAmount(value) ?? 0;
        break;

      case "Q":
        currentTransaction.quantity = parseQifAmount(value) ?? 0;
        break;

      case "O":
        currentTransaction.commission = parseQifAmount(value) ?? 0;
        break;

      case "^": {
        if (currentSplit && currentSplit.category !== undefined) {
          currentSplits.push(currentSplit as QifSplit);
        }

        if (currentTransaction.date) {
          const isOB =
            currentTransaction.payee?.toLowerCase() === "opening balance" ||
            (currentTransaction.isTransfer &&
              currentTransaction.payee
                ?.toLowerCase()
                .includes("opening balance"));

          if (isOB && blockOpeningBalance === null) {
            blockOpeningBalance = currentTransaction.amount || 0;
            blockOpeningBalanceDate = currentTransaction.date;
          } else {
            currentTransaction.splits = currentSplits;
            currentBlock.transactions.push(
              currentTransaction as QifTransaction,
            );
            blockTransactionRawDates.push(
              blockRawDates[blockRawDates.length - 1],
            );
          }
        }

        currentTransaction = null;
        currentSplits = [];
        currentSplit = null;
        break;
      }
    }
  }

  // Finalize last block
  finalizeBlock();

  // Detect date format from all raw dates collected
  const detectedDateFormat = dateFormat || detectDateFormat(rawDates);

  // If no explicit format was provided and we detected one, re-parse with it
  if (!dateFormat && rawDates.length > 0) {
    return parseQifFull(content, detectedDateFormat);
  }

  const sampleDates = [...new Set(rawDates)].slice(0, 3);

  return {
    categoryDefs,
    tagDefs,
    accountBlocks,
    detectedDateFormat: detectedDateFormat || "MM/DD/YYYY",
    sampleDates,
    isMultiAccount: accountBlocks.length > 1 || categoryDefs.length > 0,
  };
}

export function validateQifContent(content: string): {
  valid: boolean;
  error?: string;
} {
  if (!content || !content.trim()) {
    return { valid: false, error: "File is empty" };
  }

  // Check for QIF header
  if (!content.includes("!Type:") && !content.includes("!Account")) {
    // Some QIF files don't have headers, check for transaction markers
    if (!content.includes("^")) {
      return {
        valid: false,
        error: "Invalid QIF format: no transaction markers found",
      };
    }
  }

  return { valid: true };
}
