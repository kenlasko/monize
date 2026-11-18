import { PayloadTooLargeException } from "@nestjs/common";
import { tr } from "../../i18n/translate";
import type { KmyErrorCode } from "./model/kmy-errors";

/**
 * The one localized "file too large" error for a KMyMoney upload, shared by the
 * upload interceptor and the handler's own bound check.
 */
export function kmyFileTooLargeException(
  limitMb: number,
): PayloadTooLargeException {
  return new PayloadTooLargeException({
    message: tr(
      "errors.import.kmyFileTooLarge",
      // Interpolated in the fallback too: outside a request context `tr`
      // returns it verbatim.
      `That KMyMoney file is larger than the ${limitMb} MB import limit.`,
      { limit: limitMb },
    ),
    errorCode: "kmyFileTooLarge",
  });
}

/**
 * One localized message per refusal code (spec 8.2). The frontend branches on
 * `errorCode`; the message is what a person reads.
 */
export const KMY_ERROR_MESSAGES: Record<
  KmyErrorCode,
  (limitMb: number) => string
> = {
  kmyNotAKmyMoneyFile: () =>
    tr(
      "errors.import.kmyNotAKmyMoneyFile",
      "That file is not a KMyMoney file. Choose the .kmy or .xml file KMyMoney saves. If your KMyMoney data is in an SQL database, open it in KMyMoney and use File, Save As to save it as a .kmy file first.",
    ),
  kmyEncryptedFile: () =>
    tr(
      "errors.import.kmyEncryptedFile",
      "That KMyMoney file is encrypted with GPG, which Monize cannot open. In KMyMoney, turn off encryption (Settings, Configure KMyMoney, Encryption) and save the file again, or decrypt a copy with gpg --decrypt, then import that.",
    ),
  kmySqliteDatabase: () =>
    tr(
      "errors.import.kmySqliteDatabase",
      "That is a KMyMoney SQL database. Open it in KMyMoney, choose File, Save As, pick the KMyMoney (.kmy) format, and import the saved file.",
    ),
  kmyAnonymizedFile: () =>
    tr(
      "errors.import.kmyAnonymizedFile",
      "That is an anonymized KMyMoney file: KMyMoney scrambles every amount and replaces the names when it writes one, so it cannot be imported. Import your original .kmy file instead.",
    ),
  kmyLegacyBinaryFile: () =>
    tr(
      "errors.import.kmyLegacyBinaryFile",
      "That file uses the binary format of KMyMoney 0.8 or earlier. Open it in a current KMyMoney and save it again, then import the result.",
    ),
  kmyCorruptFile: () =>
    tr(
      "errors.import.kmyCorruptFile",
      "That KMyMoney file is damaged or incomplete and could not be read. If it was copied or downloaded, try the original file again.",
    ),
  kmyXmlTooLarge: (limitMb) =>
    tr(
      "errors.import.kmyXmlTooLarge",
      `That KMyMoney file is larger than the ${limitMb} MB import limit once uncompressed.`,
      { limit: limitMb },
    ),
};
