import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  KmyAnonymizedFileError,
  KmyCorruptFileError,
  KmyImportError,
} from "../model/kmy-errors";
import type { KmyRawFile } from "../model/kmy-raw";
import { KmyByteFilter } from "./kmy-byte-filter";
import { openKmyContainer } from "./kmy-container";
import { KMY_YIELD_EVERY_BYTES } from "./kmy-limits";
import { KmyRawCollector } from "./kmy-raw-collector";
import { KmyXmlByteTokenizer } from "./kmy-xml-tokenize";

export interface KmyReadInput {
  /** Not mutated. */
  readonly bytes: Buffer;
  readonly filename: string;
  /** The parser service passes `KMY_MAX_XML_BYTES`. */
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

/**
 * Uploaded bytes to the raw model, or a `KmyImportError`. The document is
 * read as a stream -- inflated, filtered, decoded and tokenized chunk by chunk
 * -- so neither the inflated document nor a filtered copy of it is ever held
 * whole, every bound of `kmy-limits.ts` is checked as the bytes arrive, and
 * the reader hands the event loop back every `KMY_YIELD_EVERY_BYTES` (B2).
 */
export async function readKmyFile(input: KmyReadInput): Promise<KmyRawFile> {
  try {
    const { container, chunks } = openKmyContainer(
      input.bytes,
      input.maxXmlBytes,
    );
    if (input.filename.toLowerCase().endsWith(".anon.xml")) {
      throw new KmyAnonymizedFileError();
    }
    const collector = new KmyRawCollector();
    const tokenizer = new KmyXmlByteTokenizer(collector);
    const filter = new KmyByteFilter();
    let sinceYield = 0;
    for await (const chunk of chunks) {
      tokenizer.write(filter.push(chunk));
      sinceYield += chunk.length;
      if (sinceYield >= KMY_YIELD_EVERY_BYTES) {
        sinceYield = 0;
        await yieldToEventLoop();
      }
    }
    tokenizer.write(filter.flush());
    tokenizer.end();
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
