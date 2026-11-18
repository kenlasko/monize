import { MnyImportError } from "../../mny/mny-errors";

/**
 * Every way a KMyMoney file can be refused before a model exists. The
 * controller maps the code to `errors.import.<code>`; the messages here are
 * English for logs only and are never shown.
 */
export type KmyErrorCode =
  | "kmyNotAKmyMoneyFile"
  | "kmyEncryptedFile"
  | "kmySqliteDatabase"
  | "kmyAnonymizedFile"
  | "kmyLegacyBinaryFile"
  | "kmyCorruptFile"
  | "kmyXmlTooLarge";

export class KmyImportError extends MnyImportError<KmyErrorCode> {}

export class KmyNotAKmyMoneyFileError extends KmyImportError {
  constructor() {
    super("kmyNotAKmyMoneyFile", "File is not a KMyMoney file");
  }
}

export class KmyEncryptedFileError extends KmyImportError {
  constructor() {
    super("kmyEncryptedFile", "KMyMoney file is GPG encrypted");
  }
}

export class KmySqliteDatabaseError extends KmyImportError {
  constructor() {
    super("kmySqliteDatabase", "File is a KMyMoney SQLite database");
  }
}

export class KmyAnonymizedFileError extends KmyImportError {
  constructor() {
    super("kmyAnonymizedFile", "KMyMoney file is an anonymized copy");
  }
}

export class KmyLegacyBinaryFileError extends KmyImportError {
  constructor() {
    super(
      "kmyLegacyBinaryFile",
      "KMyMoney file uses the binary format of version 0.8 or earlier",
    );
  }
}

export class KmyCorruptFileError extends KmyImportError {
  constructor(detail: string, cause?: unknown) {
    super("kmyCorruptFile", `KMyMoney file is corrupt: ${detail}`, cause);
  }
}

export class KmyXmlTooLargeError extends KmyImportError {
  constructor(limitMb: number) {
    super(
      "kmyXmlTooLarge",
      `KMyMoney file is larger than ${limitMb} MB once uncompressed`,
    );
  }
}
