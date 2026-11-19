import { createGunzip } from "zlib";
import {
  KmyCorruptFileError,
  KmyEncryptedFileError,
  KmyLegacyBinaryFileError,
  KmyNotAKmyMoneyFileError,
  KmySqliteDatabaseError,
  KmyXmlTooLargeError,
} from "../model/kmy-errors";

/**
 * Spec 4.3: rows 1 to 7, applied to the uploaded bytes and then to the
 * document. The document is never materialized: a gzip is inflated as a
 * stream and its byte count checked chunk by chunk, so a bomb is refused at
 * the first chunk past the bound, and plain XML is handed on in slices of the
 * upload itself (views, never copies).
 */

export interface KmyContainer {
  readonly container: "gzip" | "xml";
  /**
   * The document bytes in order, UTF-8 BOM removed, rows 6 and 7 already
   * checked against its head. Iterating it throws a `KmyImportError` when the
   * document breaks a rule; the input is never mutated.
   */
  readonly chunks: AsyncIterable<Buffer>;
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
const PGP_ARMOUR = Buffer.from("-----BEGIN PGP", "latin1");
const ROOT_MARKER = "<KMYMONEY-FILE";
const ROOT_SEARCH_BYTES = 4096;
const BOM = [0xef, 0xbb, 0xbf] as const;
/** zlib's output chunk, and the slice of a plain upload handed on at once. */
const CHUNK_BYTES = 64 * 1024;

export function limitMb(maxXmlBytes: number): number {
  return Math.round((maxXmlBytes / (1024 * 1024)) * 100) / 100;
}

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return (
    bytes.length >= prefix.length &&
    bytes.subarray(0, prefix.length).equals(prefix)
  );
}

function looksEncrypted(bytes: Buffer): boolean {
  if (startsWith(bytes, PGP_ARMOUR)) {
    return true;
  }
  const first = bytes[0];
  if (first === 0x85 && (bytes[1] === 0x01 || bytes[1] === 0x02)) {
    return true;
  }
  // Bit 7 set and not the first byte of a UTF-8 BOM.
  return first >= 0x80 && first !== BOM[0];
}

function hasBom(bytes: Buffer): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === BOM[0] &&
    bytes[1] === BOM[1] &&
    bytes[2] === BOM[2]
  );
}

/** Rows 6 and 7 over the document's head, BOM already removed. */
function checkHead(head: Buffer): void {
  const first = head[0];
  const legacy =
    (first !== undefined &&
      first < 0x20 &&
      first !== 0x09 &&
      first !== 0x0a &&
      first !== 0x0d) ||
    (head.length >= 8 && head.subarray(0, 8).toString("latin1") === "KMyMoney");
  if (legacy) {
    throw new KmyLegacyBinaryFileError();
  }
  if (
    !head
      .subarray(0, ROOT_SEARCH_BYTES)
      .toString("latin1")
      .includes(ROOT_MARKER)
  ) {
    throw new KmyNotAKmyMoneyFileError();
  }
}

/** The inflated stream, counted: past `maxXmlBytes` it stops and refuses. */
async function* inflated(
  bytes: Buffer,
  maxXmlBytes: number,
): AsyncGenerator<Buffer> {
  const gunzip = createGunzip({ chunkSize: CHUNK_BYTES });
  gunzip.end(bytes);
  let total = 0;
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxXmlBytes) {
        throw new KmyXmlTooLargeError(limitMb(maxXmlBytes));
      }
      yield chunk;
    }
  } catch (err) {
    if (err instanceof KmyXmlTooLargeError) {
      throw err;
    }
    throw new KmyCorruptFileError("the gzip stream cannot be inflated", err);
  } finally {
    gunzip.destroy();
  }
}

function* slices(bytes: Buffer): Generator<Buffer> {
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    yield bytes.subarray(offset, offset + CHUNK_BYTES);
  }
}

/**
 * The document after rows 6 and 7: the BOM dropped, the head held back until
 * it is long enough to check (or the document ends), then everything passed on.
 */
async function* checked(
  source: AsyncIterable<Buffer> | Iterable<Buffer>,
): AsyncGenerator<Buffer> {
  let head: Buffer | null = Buffer.alloc(0);
  for await (const chunk of source) {
    if (head === null) {
      yield chunk;
      continue;
    }
    head = Buffer.concat([head, chunk]);
    if (head.length < ROOT_SEARCH_BYTES + BOM.length) {
      continue;
    }
    const body: Buffer = hasBom(head) ? head.subarray(3) : head;
    head = null;
    checkHead(body);
    yield body;
  }
  if (head !== null) {
    const body = hasBom(head) ? head.subarray(3) : head;
    checkHead(body);
    if (body.length > 0) {
      yield body;
    }
  }
}

/** Rows 1 to 5 on the uploaded bytes, synchronously; the document follows lazily. */
export function openKmyContainer(
  bytes: Buffer,
  maxXmlBytes: number,
): KmyContainer {
  if (bytes.length < 2) {
    throw new KmyNotAKmyMoneyFileError();
  }
  if (startsWith(bytes, SQLITE_MAGIC)) {
    throw new KmySqliteDatabaseError();
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return { container: "gzip", chunks: checked(inflated(bytes, maxXmlBytes)) };
  }
  if (looksEncrypted(bytes)) {
    throw new KmyEncryptedFileError();
  }
  if (bytes.length > maxXmlBytes) {
    throw new KmyXmlTooLargeError(limitMb(maxXmlBytes));
  }
  return { container: "xml", chunks: checked(slices(bytes)) };
}
