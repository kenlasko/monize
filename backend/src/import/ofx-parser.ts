/**
 * OFX (Open Financial Exchange) Parser
 *
 * OFX files use an SGML-based format (not proper XML).
 * This parser handles bank and credit card statements (BANKMSGSRSV1, CREDITCARDMSGSRSV1).
 * Investment statements (INVSTMTMSGSRSV1) are not supported.
 *
 * OFX Format Reference:
 * - Headers appear before the <OFX> tag as key:value pairs
 * - SGML tags may or may not have closing tags
 * - STMTTRN elements contain individual transactions
 * - DTPOSTED = date (YYYYMMDD or YYYYMMDDHHMMSS[.XXX:TZ])
 * - TRNAMT = amount (signed decimal; a period or a comma separates the decimals)
 * - NAME = payee name
 * - MEMO = memo/description
 * - FITID = financial institution transaction ID
 * - CHECKNUM = check number
 * - TRNTYPE = transaction type (DEBIT, CREDIT, CHECK, DEP, ATM, POS, XFER, etc.)
 */

import type { QifTransaction, QifParseResult } from "./qif-parser";
import { MONEY_SCALE, roundMoney } from "../common/round.util";

// Strip HTML angle brackets to prevent stored XSS.
function stripHtml(value: string): string {
  return value.replace(/[<>]/g, "");
}

// Truncate a string to a maximum length.
function truncate(value: string, maxLength: number): string {
  const sanitized = stripHtml(value);
  return sanitized.length > maxLength
    ? sanitized.substring(0, maxLength)
    : sanitized;
}

/**
 * Parse an OFX date string into YYYY-MM-DD format.
 * Supports: YYYYMMDD, YYYYMMDDHHMMSS, YYYYMMDDHHMMSS.XXX[TZ]
 */
function parseOfxDate(dateStr: string): string {
  if (!dateStr) return "";
  // Cap the input length before running regexes so the total work is linear
  // in a bounded constant. Even if a regex had polynomial worst-case, it
  // cannot exhibit a DoS on inputs this small (CWE-1333).
  if (dateStr.length > 64) {
    dateStr = dateStr.slice(0, 64);
  }
  // Strip timezone info and fractional seconds. Use [^[\]]* (neither '['
  // nor ']') so the inner match is anchored unambiguously between a single
  // pair of brackets. Inside a character class, '[' does not require
  // escaping, only ']' does.
  const cleaned = dateStr
    .replace(/\[[^[\]]*\]/, "")
    .replace(/\..*/, "")
    .trim();
  if (cleaned.length < 8) return "";

  const year = cleaned.substring(0, 4);
  const month = cleaned.substring(4, 6);
  const day = cleaned.substring(6, 8);

  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const d = parseInt(day, 10);

  if (isNaN(y) || isNaN(m) || isNaN(d)) return "";
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Map OFX account type to the internal account type string.
 */
function mapAccountType(acctType: string): string {
  switch (acctType.toUpperCase()) {
    case "CHECKING":
      return "CHEQUING";
    case "SAVINGS":
      return "SAVINGS";
    case "CREDITLINE":
      return "LINE_OF_CREDIT";
    case "MONEYMRKT":
      return "SAVINGS";
    default:
      return "CHEQUING";
  }
}

/**
 * Extract a tag value from OFX SGML content.
 * OFX tags are like <TAGNAME>value (no closing tag for leaf values).
 */
function getTagValue(content: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([^<\\r\\n]*)`, "i");
  const match = content.match(regex);
  return match ? match[1].trim() : "";
}

/**
 * Extract all occurrences of a block between open and close tags.
 */
function extractBlocks(
  content: string,
  openTag: string,
  closeTag: string,
): string[] {
  const blocks: string[] = [];
  const openTagUpper = openTag.toUpperCase();
  const closeTagUpper = closeTag.toUpperCase();
  const upper = content.toUpperCase();

  let searchFrom = 0;
  while (true) {
    const start = upper.indexOf(openTagUpper, searchFrom);
    if (start === -1) break;

    const contentStart = start + openTagUpper.length;
    const end = upper.indexOf(closeTagUpper, contentStart);
    if (end === -1) {
      // No close tag -- take until end of content
      blocks.push(content.substring(contentStart));
      break;
    }

    blocks.push(content.substring(contentStart, end));
    searchFrom = end + closeTagUpper.length;
  }

  return blocks;
}

/**
 * The rows with the `FITID` dropped from every row whose `FITID` another row of
 * the same file also carries. The specification makes a `FITID` unique per
 * account, but some banks give several rows the same one, and keying on it
 * would skip every row after the first as already imported. Such rows import
 * without a key, as every OFX row did before the import read it.
 */
function dropRepeatedFitIds(
  transactions: readonly QifTransaction[],
): QifTransaction[] {
  const seen = new Map<string, number>();
  for (const tx of transactions) {
    if (tx.fitId) seen.set(tx.fitId, (seen.get(tx.fitId) ?? 0) + 1);
  }
  return transactions.map((tx) => {
    if (!tx.fitId || (seen.get(tx.fitId) ?? 0) <= 1) return tx;
    const { fitId: _repeated, ...withoutFitId } = tx;
    return withoutFitId;
  });
}

/**
 * Validate that content looks like an OFX file.
 */
export function validateOfxContent(content: string): {
  valid: boolean;
  error?: string;
} {
  if (!content || content.trim().length === 0) {
    return { valid: false, error: "File is empty" };
  }

  const upper = content.toUpperCase();

  // Must contain an OFX tag
  if (!upper.includes("<OFX>") && !upper.includes("<OFX ")) {
    return { valid: false, error: "Not a valid OFX file: missing <OFX> tag" };
  }

  // Must contain at least one statement response
  const hasBank = upper.includes("<BANKMSGSRSV1>");
  const hasCreditCard = upper.includes("<CREDITCARDMSGSRSV1>");

  if (!hasBank && !hasCreditCard) {
    return {
      valid: false,
      error:
        "Not a supported OFX file: no bank or credit card statement found. Investment OFX files are not supported.",
    };
  }

  return { valid: true };
}

/**
 * Parse an OFX file into the standard QifParseResult format.
 *
 * Amounts are read at the storage scale (`MONEY_SCALE`, eight places), never at
 * the destination account's precision: the import processor refuses an amount
 * with more places than the account's currency carries (INV-MONEY-001), exactly
 * as it does for QIF and CSV, so a figure is never silently rounded here.
 */
export function parseOfx(content: string): QifParseResult {
  const transactions: QifTransaction[] = [];
  const transferAccountNames = new Set<string>();
  const sampleDates: string[] = [];

  // Determine if this is a credit card statement
  const upper = content.toUpperCase();
  const isCreditCard = upper.includes("<CREDITCARDMSGSRSV1>");

  // Extract account type
  let accountType = isCreditCard ? "CREDIT_CARD" : "CHEQUING";
  const acctTypeValue = getTagValue(content, "ACCTTYPE");
  if (acctTypeValue) {
    accountType = mapAccountType(acctTypeValue);
  }

  // Extract transaction blocks
  const txBlocks = extractBlocks(content, "<STMTTRN>", "</STMTTRN>");

  for (const block of txBlocks) {
    const dateStr = getTagValue(block, "DTPOSTED");
    const date = parseOfxDate(dateStr);
    if (!date) continue;

    if (sampleDates.length < 3) {
      sampleDates.push(dateStr.substring(0, 8));
    }

    // The OFX specification lets an amount use a comma as its decimal
    // separator and allows no digit grouping, so "-18,36" is -18.36; a bare
    // parseFloat stopped at the comma and imported -18.
    const amountStr = getTagValue(block, "TRNAMT");
    const amount = parseFloat(amountStr.replace(",", "."));
    if (isNaN(amount)) continue;

    const trnType = getTagValue(block, "TRNTYPE").toUpperCase();
    const name = getTagValue(block, "NAME");
    const memo = getTagValue(block, "MEMO");
    const checkNum = getTagValue(block, "CHECKNUM");
    const fitId = getTagValue(block, "FITID");

    // Determine cleared status based on transaction type
    const isCleared = true; // OFX transactions are typically already posted
    const isTransfer = trnType === "XFER";

    // For transfers, use the payee name as the transfer account name
    let transferAccount = "";
    if (isTransfer && name) {
      transferAccount = truncate(name, 255);
      transferAccountNames.add(transferAccount);
    }

    const payee = truncate(name || memo || "", 255);
    const memoText = truncate(name && memo && name !== memo ? memo : "", 5000);

    const tx: QifTransaction = {
      date,
      amount: roundMoney(amount, MONEY_SCALE),
      payee,
      memo: memoText,
      number: truncate(checkNum, 100),
      ...(fitId ? { fitId } : {}),
      cleared: isCleared,
      reconciled: false,
      category: "",
      isTransfer,
      transferAccount,
      splits: [],
      // Investment fields (not used for bank/credit card)
      security: "",
      action: "",
      price: 0,
      quantity: 0,
      commission: 0,
      tagNames: [],
    };

    transactions.push(tx);
  }

  return {
    accountType,
    accountName: "",
    transactions: dropRepeatedFitIds(transactions),
    categories: [],
    transferAccounts: Array.from(transferAccountNames),
    securities: [],
    detectedDateFormat: "YYYY-MM-DD",
    sampleDates,
    openingBalance: null,
    openingBalanceDate: null,
  };
}
