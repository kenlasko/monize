import {
  KmyAnonymizedFileError,
  KmyCorruptFileError,
  KmyImportError,
} from "../model/kmy-errors";
import type { KmyRawFile } from "../model/kmy-raw";
import { filterKmyBytes } from "./kmy-byte-filter";
import { openKmyContainer } from "./kmy-container";
import { KmyRawCollector } from "./kmy-raw-collector";
import { tokenizeKmyXml } from "./kmy-xml-tokenize";

export interface KmyReadInput {
  /** Not mutated. */
  readonly bytes: Buffer;
  readonly filename: string;
  /** WP3b passes MNY_IMPORT_LIMIT_BYTES. */
  readonly maxXmlBytes: number;
}

/**
 * Spec 4.3 row 8: the filename says so, or every non-standard account and
 * every payee is named by its own id (KMyMoney's "anonymize" export).
 */
function isAnonymized(file: KmyRawFile, filename: string): boolean {
  if (filename.toLowerCase().endsWith(".anon.xml")) {
    return true;
  }
  const accounts = file.accounts.filter((account) => !account.isStandard);
  return (
    accounts.length > 0 &&
    accounts.every((account) => account.name === account.id) &&
    file.payees.every((payee) => payee.name === payee.id)
  );
}

/** Uploaded bytes to the raw model, or a `KmyImportError`. */
export function readKmyFile(input: KmyReadInput): KmyRawFile {
  try {
    const { container, xml } = openKmyContainer(input.bytes, input.maxXmlBytes);
    if (input.filename.toLowerCase().endsWith(".anon.xml")) {
      throw new KmyAnonymizedFileError();
    }
    const collector = new KmyRawCollector();
    tokenizeKmyXml(filterKmyBytes(xml), collector);
    const file = collector.finish(container);
    if (isAnonymized(file, input.filename)) {
      throw new KmyAnonymizedFileError();
    }
    return file;
  } catch (err) {
    if (err instanceof KmyImportError) {
      throw err;
    }
    throw new KmyCorruptFileError("the file cannot be read", err);
  }
}
