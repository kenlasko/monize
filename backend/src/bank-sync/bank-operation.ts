import { englishEmailT, type EmailT } from "../i18n/email-translator";
import {
  findOperationType,
  type BankSyncProfile,
  type OperationDirection,
} from "./bank-sync-profiles";

/**
 * The bank's own name for what kind of operation a transaction was (spec
 * section 7b): `CARD-PAYMENT`, `TRANSFER-IN`, a `bank_transaction_code`. It is
 * read beside the description and never out of it, because the description is
 * part of the `hash:` duplicate key (spec section 6) and a changed description
 * would import the same row twice.
 */
export interface BankOperation {
  /** `bank_transaction_code.code`, bounded; null when the bank sent none. */
  code: string | null;
  /** `bank_transaction_code.sub_code`, bounded. */
  subCode: string | null;
  /** `bank_transaction_code.description`, bounded. */
  description: string | null;
  /**
   * An upper-case hyphenated code found in a remittance line (the line itself,
   * or its last word): `CARD-PAYMENT`, `MOBILE-PAYMENT-POS-NO-CARD-TX-CODE`.
   */
  remittanceCode: string | null;
}

export const NO_BANK_OPERATION: BankOperation = Object.freeze({
  code: null,
  subCode: null,
  description: null,
  remittanceCode: null,
});

/** The longest operation text kept: the width of `tags.name`, which it can become. */
export const BANK_OPERATION_MAX_LENGTH = 100;

/** An operation code as banks write one: `CARD-PAYMENT`, `ATM-WITHDRAWAL-FOREIGN`. */
export const OPERATION_CODE_PATTERN = /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/;

/**
 * What may become a tag's name when the code is not a known one: letters,
 * digits and a little punctuation, starting with a letter or a digit. A bank is
 * a third party, so markup and control characters never reach a tag.
 */
const SAFE_TAG_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _./:+-]*$/u;

/** Which remittance line held the operation code, and whether it was the whole line. */
export interface RemittanceOperation {
  code: string;
  /** Index into the lines given, so a caller can tell which line it was. */
  lineIndex: number;
  /**
   * True when the line is the code and nothing else (`CARD-PAYMENT`); false when
   * the code is only the last word of a longer line (`Zakupy CARD-PAYMENT`).
   */
  wholeLine: boolean;
}

/**
 * The operation code in a bank's remittance lines and the line it was found on:
 * the first line that is a code, or whose last whitespace-separated word is
 * one. Null when none is.
 */
export function findRemittanceOperation(
  lines: readonly string[],
): RemittanceOperation | null {
  for (const [lineIndex, line] of lines.entries()) {
    const trimmed = line.trim();
    if (OPERATION_CODE_PATTERN.test(trimmed)) {
      return { code: trimmed, lineIndex, wholeLine: true };
    }
    const lastWord = trimmed.split(/\s+/).pop() ?? "";
    if (OPERATION_CODE_PATTERN.test(lastWord)) {
      return { code: lastWord, lineIndex, wholeLine: false };
    }
  }
  return null;
}

/**
 * The operation code in a bank's remittance lines: the first line that is a
 * code, or whose last whitespace-separated word is one. Null when none is.
 */
export function remittanceOperationCode(
  lines: readonly string[],
): string | null {
  return findRemittanceOperation(lines)?.code ?? null;
}

export type { OperationDirection };

/** The tag an operation gives a transaction. */
export interface OperationTag {
  /**
   * What names the operation: the family of a known code (`CARD-PAYMENT`,
   * `MOBILE-PAYMENT`, `ATM`, `TRANSFER-IN`), the code itself for an unknown one.
   */
  key: string;
  /** The tag's name, in the translator's language for a known code. */
  label: string;
}

/**
 * The tag a bank operation gives a transaction, or null when the bank named no
 * operation Monize can use as a tag name.
 *
 * The operation is the first of the remittance code, the transaction code's
 * sub code, its code and its description that the bank gave. A code the
 * `profile` knows (the profile of the connection's institution, spec section 7b
 * and docs/future-plans/source-profiles.md) takes its translated label (`t`, the
 * recipient's language); any other is its own name, kept as the bank wrote it,
 * provided it is plain text of at most a tag name's width: a value that is not is
 * no tag, never a mangled one. Which line or field the operation is read from does
 * not depend on the profile: only the label it is given does.
 *
 * `direction` is the way the money moved, for a code that does not say it itself
 * (a bare `TRANSFER` in the PKO BP profile: an incoming transfer for a credit and
 * an outgoing one for a debit). Without a direction it is an unknown code, and so
 * its own name.
 */
export function operationTagLabel(
  operation: BankOperation,
  profile: BankSyncProfile,
  t: EmailT = englishEmailT,
  direction: OperationDirection | null = null,
): OperationTag | null {
  const candidate = [
    operation.remittanceCode,
    operation.subCode,
    operation.code,
    operation.description,
  ]
    .map((value) => value?.trim() ?? "")
    .find((value) => value !== "");
  if (candidate === undefined) return null;

  const known = findOperationType(profile, candidate.toUpperCase(), direction);
  if (known !== null) {
    return {
      key: known.key,
      label: t(
        `common.bankSync.operationTypes.${known.catalogKey}`,
        known.fallback,
      ),
    };
  }
  if (candidate.length > BANK_OPERATION_MAX_LENGTH) return null;
  return SAFE_TAG_NAME.test(candidate)
    ? { key: candidate, label: candidate }
    : null;
}
