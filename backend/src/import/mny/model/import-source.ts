import type { MnyImportOptions } from "./mny-import-options";
import type { MnyParsedFile } from "../mny-parser.service";

/**
 * The contract a binary-file import source shares with the Money pipeline:
 * which formats exist, what a KMyMoney file reports about its container, and
 * the token the shared import service injects the KMyMoney parser through.
 * Types and one token; no logic.
 */
export type ImportSourceFormat = "mny" | "kmy";

export interface KmyFileSummary {
  readonly container: "gzip" | "xml";
  /** Decoded FIXVERSION (R2.3); 12 is current. */
  readonly fixVersion: number;
  /** FILEINFO/APPVERSION id, e.g. "5.2.70-94cd76bbb"; null when absent. */
  readonly appVersion: string | null;
  /** FILEINFO/LAST_MODIFIED_DATE as written; null when absent. */
  readonly lastModified: string | null;
  /**
   * YYYY-MM-DD the file's own figures (balances, holdings, overdue schedules)
   * are computed at: the day the parse ran. The preview's and the job's can
   * differ when the import is started on a later day than the upload.
   */
  readonly asOf: string;
}

export interface ImportSourceParseInput {
  readonly userId: string;
  /** Staged or uploaded bytes, as they arrived. Not mutated. */
  readonly buffer: Buffer;
  /** Original filename; the anonymized-file test reads its suffix. */
  readonly filename: string;
  readonly options?: Partial<MnyImportOptions>;
  /** When absent the parser reads the user's preference itself. */
  readonly userDefaultCurrency?: string;
  /** YYYY-MM-DD; default today (todayIsoDate). */
  readonly asOf?: string;
}

export interface ImportSourceParser {
  readonly sourceFormat: Exclude<ImportSourceFormat, "mny">;
  /** @throws MnyImportError subclasses (KmyImportError) for every unreadable file. */
  parse(input: ImportSourceParseInput): Promise<MnyParsedFile>;
}

export const KMY_SOURCE_PARSER = Symbol("KMY_SOURCE_PARSER");
