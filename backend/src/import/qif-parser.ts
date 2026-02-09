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

  let accountType = "Bank";
  const accountName = "";
  let currentTransaction: Partial<QifTransaction> | null = null;
  let currentSplits: QifSplit[] = [];
  let currentSplit: Partial<QifSplit> | null = null;
  let openingBalance: number | null = null;
  let openingBalanceDate: string | null = null;

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
          break;
        case "cash":
          accountType = "CASH";
          break;
        case "ccard":
          accountType = "CREDIT_CARD";
          break;
        case "invst":
          accountType = "INVESTMENT";
          break;
        case "oth a":
          accountType = "ASSET";
          break;
        case "oth l":
          accountType = "LINE_OF_CREDIT";
          break;
        default:
          accountType = "OTHER";
      }
      continue;
    }

    // Account name
    if (line.startsWith("!Account")) {
      continue;
    }

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
        currentTransaction.amount = parseQifAmount(value);
        break;

      case "P": // Payee
        currentTransaction.payee = value;
        break;

      case "M": // Memo
        currentTransaction.memo = value;
        break;

      case "N": // Number (cheque number) OR Action (for investment transactions)
        currentTransaction.number = value;
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
        // Category or Transfer
        const { category, isTransfer, transferAccount } =
          parseCategoryOrTransfer(value);
        currentTransaction.category = category;
        currentTransaction.isTransfer = isTransfer;
        currentTransaction.transferAccount = transferAccount;

        if (isTransfer) {
          transferAccountsSet.add(transferAccount);
        } else if (category) {
          categoriesSet.add(category);
        }
        break;
      }

      case "S": {
        // Split category
        // Save previous split if exists
        if (currentSplit && currentSplit.category !== undefined) {
          currentSplits.push(currentSplit as QifSplit);
        }

        const splitParsed = parseCategoryOrTransfer(value);
        currentSplit = {
          category: splitParsed.category,
          memo: "",
          amount: 0,
          isTransfer: splitParsed.isTransfer,
          transferAccount: splitParsed.transferAccount,
        };

        if (splitParsed.isTransfer) {
          transferAccountsSet.add(splitParsed.transferAccount);
        } else if (splitParsed.category) {
          categoriesSet.add(splitParsed.category);
        }
        break;
      }

      case "E": // Split memo
        if (currentSplit) {
          currentSplit.memo = value;
        }
        break;

      case "$": // Split amount
        if (currentSplit) {
          currentSplit.amount = parseQifAmount(value);
        }
        break;

      // Investment-specific fields
      case "Y": // Security name/symbol
        currentTransaction.security = value;
        if (value) {
          securitiesSet.add(value);
        }
        break;

      case "I": // Price per share
        currentTransaction.price = parseQifAmount(value);
        break;

      case "Q": // Quantity (number of shares)
        currentTransaction.quantity = parseQifAmount(value);
        break;

      case "O": // Commission
        currentTransaction.commission = parseQifAmount(value);
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
          } else {
            currentTransaction.splits = currentSplits;
            transactions.push(currentTransaction as QifTransaction);
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
  }

  // Detect date format from raw dates
  const detectedDateFormat = dateFormat || detectDateFormat(rawDates);

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

function detectDateFormat(dates: string[]): DateFormat {
  if (dates.length === 0) return "MM/DD/YYYY";

  // Check for YYYY-MM-DD or YYYY-DD-MM format (ISO-like)
  const isoMatch = dates[0]?.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const [, , part2, part3] = isoMatch;
    const p2 = parseInt(part2);
    const p3 = parseInt(part3);

    // If second part > 12, it's likely the day (YYYY-DD-MM)
    if (p2 > 12) return "YYYY-DD-MM";
    // If third part > 12, it's likely the day (YYYY-MM-DD)
    if (p3 > 12) return "YYYY-MM-DD";

    // Check multiple dates to make a better guess
    for (const date of dates.slice(0, 10)) {
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
  for (const date of dates.slice(0, 10)) {
    const match = date.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
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
  // Remove any quotes
  dateStr = dateStr.replace(/['"]/g, "").trim();

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

  // Try MM/DD/YYYY or DD/MM/YYYY format
  match = dateStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (match) {
    const [, part1, part2, yearRaw] = match;
    let year = yearRaw;

    // Convert 2-digit year to 4-digit
    if (year.length === 2) {
      const yearNum = parseInt(year);
      year = yearNum > 50 ? `19${year}` : `20${year}`;
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

  // Try alternate format with apostrophe for year: M/D'YY
  match = dateStr.match(/^(\d{1,2})[-/](\d{1,2})['"]?(\d{2})$/);
  if (match) {
    const [, part1, part2, year] = match;
    const yearNum = parseInt(year);
    const fullYear = yearNum > 50 ? `19${year}` : `20${year}`;

    let month: string, day: string;
    if (format === "DD/MM/YYYY") {
      day = part1.padStart(2, "0");
      month = part2.padStart(2, "0");
    } else {
      month = part1.padStart(2, "0");
      day = part2.padStart(2, "0");
    }

    return `${fullYear}-${month}-${day}`;
  }

  // Return as-is if can't parse
  return dateStr;
}

function parseQifAmount(amountStr: string): number {
  // Remove currency symbols, spaces, and commas
  const cleaned = amountStr.replace(/[$£€,\s]/g, "");
  const amount = parseFloat(cleaned);
  return isNaN(amount) ? 0 : amount;
}

function parseCategoryOrTransfer(value: string): {
  category: string;
  isTransfer: boolean;
  transferAccount: string;
} {
  // Transfers are denoted by [Account Name]
  const transferMatch = value.match(/^\[(.+)\]$/);
  if (transferMatch) {
    return {
      category: "",
      isTransfer: true,
      transferAccount: transferMatch[1],
    };
  }

  // Category might have subcategory separated by :
  // e.g., "Food:Groceries" or just "Food"
  return {
    category: value,
    isTransfer: false,
    transferAccount: "",
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
