/**
 * Error taxonomy for the Microsoft Money (`.mny`) import pipeline.
 *
 * Every failure the parser can produce carries a stable `code`. The controller
 * layer maps the code to an i18n key (`import.mny.<code>`) so the wizard can
 * show an actionable message -- most importantly telling "this file needs a
 * password" apart from "that password is wrong".
 */
export type MnyErrorCode =
  /** File is shorter than a single Jet page, or truncated mid-upload. */
  | "mnyFileTruncated"
  /** Header does not identify a Microsoft Money database. */
  | "mnyNotAMoneyFile"
  /** Jet 3 era file (Money 97/98) -- not supported. */
  | "mnyUnsupportedVersion"
  /** File is password protected and no password was supplied. */
  | "mnyPasswordRequired"
  /** A password was supplied but it does not open the file. */
  | "mnyPasswordIncorrect"
  /** Decryption succeeded but the page structure could not be parsed. */
  | "mnyUnreadableDatabase"
  /** The staged upload expired or was deleted before the import ran. */
  | "mnyStagedFileMissing"
  /** This user's ledger already holds a committed import of the same bytes. */
  | "mnyAlreadyImported";

/**
 * Base class for every `.mny` parse failure. Never include the password (or
 * any part of it) in `message` -- these messages are logged.
 */
export class MnyImportError<C extends string = MnyErrorCode> extends Error {
  constructor(
    readonly code: C,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class MnyFileTruncatedError extends MnyImportError {
  constructor(actualBytes: number, expectedBytes: number) {
    super(
      "mnyFileTruncated",
      `Money file is only ${actualBytes} bytes; at least ${expectedBytes} are needed to read the header`,
    );
  }
}

export class MnyNotAMoneyFileError extends MnyImportError {
  constructor(engineName: string) {
    super(
      "mnyNotAMoneyFile",
      `File does not look like a Microsoft Money database (engine name "${engineName}")`,
    );
  }
}

export class MnyUnsupportedVersionError extends MnyImportError {
  constructor(versionByte: number) {
    super(
      "mnyUnsupportedVersion",
      `Unsupported Money file version 0x${versionByte.toString(16)}; only Jet 4 MSISAM files and Money 97-99 Jet 3 files are read`,
    );
  }
}

export class MnyPasswordRequiredError extends MnyImportError {
  constructor() {
    super("mnyPasswordRequired", "Money file is password protected");
  }
}

export class MnyPasswordIncorrectError extends MnyImportError {
  constructor() {
    super("mnyPasswordIncorrect", "Money file password is incorrect");
  }
}

export class MnyUnreadableDatabaseError extends MnyImportError {
  constructor(cause: unknown) {
    super(
      "mnyUnreadableDatabase",
      "Money file was decrypted but its contents could not be read",
      cause,
    );
  }
}

/**
 * The staged file is gone by the time the import runs -- expired past its TTL,
 * swept, or explicitly discarded. Not retryable over the same staging row: the
 * wizard has to upload again.
 */
export class MnyStagedFileMissingError extends MnyImportError {
  constructor(stagedFileId: string) {
    super(
      "mnyStagedFileMissing",
      `Staged import file ${stagedFileId} is no longer available`,
    );
  }
}

/**
 * The commit checkpoint found these bytes already committed for this user
 * (audit A26-H08).
 *
 * Thrown from inside the import transaction, so it rolls this attempt's rows
 * back; a parse-class error, so the job is not offered Retry: the same bytes
 * would be refused again.
 */
export class MnyAlreadyImportedError extends MnyImportError {
  constructor(jobId: string, cause?: unknown) {
    super(
      "mnyAlreadyImported",
      `Import job ${jobId} refused at its commit: this user's ledger already holds a committed import of the same file`,
      cause,
    );
  }
}
