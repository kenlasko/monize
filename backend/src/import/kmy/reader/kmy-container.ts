import { gunzipSync } from "zlib";
import {
  KmyCorruptFileError,
  KmyEncryptedFileError,
  KmyLegacyBinaryFileError,
  KmyNotAKmyMoneyFileError,
  KmySqliteDatabaseError,
  KmyXmlTooLargeError,
} from "../model/kmy-errors";

/** Spec 4.3: rows 1 to 7, applied to the uploaded bytes and then to the inflated ones. */

export interface KmyContainer {
  readonly container: "gzip" | "xml";
  /** The document bytes, UTF-8 BOM removed. A view or copy; never the input itself mutated. */
  readonly xml: Buffer;
}

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
const PGP_ARMOUR = Buffer.from("-----BEGIN PGP", "latin1");
const ROOT_MARKER = "<KMYMONEY-FILE";
const ROOT_SEARCH_BYTES = 4096;
const BOM = [0xef, 0xbb, 0xbf] as const;

function limitMb(maxXmlBytes: number): number {
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

function inflate(bytes: Buffer, maxXmlBytes: number): Buffer {
  try {
    return gunzipSync(bytes, { maxOutputLength: maxXmlBytes });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new KmyXmlTooLargeError(limitMb(maxXmlBytes));
    }
    throw new KmyCorruptFileError("the gzip stream cannot be inflated", err);
  }
}

function stripBom(bytes: Buffer): Buffer {
  return bytes.length >= 3 &&
    bytes[0] === BOM[0] &&
    bytes[1] === BOM[1] &&
    bytes[2] === BOM[2]
    ? bytes.subarray(3)
    : bytes;
}

/** Rows 6 and 7 over the document bytes. */
function checkDocument(document: Buffer): Buffer {
  const xml = stripBom(document);
  const first = xml[0];
  const legacy =
    (first !== undefined &&
      first < 0x20 &&
      first !== 0x09 &&
      first !== 0x0a &&
      first !== 0x0d) ||
    (xml.length >= 8 && xml.subarray(0, 8).toString("latin1") === "KMyMoney");
  if (legacy) {
    throw new KmyLegacyBinaryFileError();
  }
  const head = xml.subarray(0, ROOT_SEARCH_BYTES).toString("latin1");
  if (!head.includes(ROOT_MARKER)) {
    throw new KmyNotAKmyMoneyFileError();
  }
  return xml;
}

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
    return {
      container: "gzip",
      xml: checkDocument(inflate(bytes, maxXmlBytes)),
    };
  }
  if (looksEncrypted(bytes)) {
    throw new KmyEncryptedFileError();
  }
  if (bytes.length > maxXmlBytes) {
    throw new KmyXmlTooLargeError(limitMb(maxXmlBytes));
  }
  return { container: "xml", xml: checkDocument(bytes) };
}
