/**
 * Decides what an uploaded `.xml` file is by reading its head, not by trusting
 * its extension: a KMyMoney file and an OFX 2.x statement are both `.xml`, and
 * they belong to different importers. Pure and synchronous over bytes already
 * read; `readXmlHead` does the (bounded) read.
 *
 * Mirrors the KMyMoney backend's own container sniffing
 * (`backend/src/import/kmy/reader/kmy-container.ts`, `docs/kmymoney-data-model.md`
 * section 1): gzip bytes `1f 8b` are KMyMoney's whatever the name (a gzip file
 * can carry `.xml`; the backend inflates it and decides), a UTF-8 BOM is
 * dropped, and the `<KMYMONEY-FILE` root is looked for in the first 4096 bytes.
 * The backend stays the authority: a file this routes to the KMyMoney importer
 * and that is not one is refused there with its own message.
 */

/** How much of the file is read. The backend's own root search covers the same 4096 bytes. */
export const XML_SNIFF_BYTES = 4096;

export type XmlImportKind = 'kmymoney' | 'ofx' | 'unknown';

const KMYMONEY_DOCTYPE = '<!DOCTYPE KMYMONEY-FILE';
const KMYMONEY_ROOT = '<KMYMONEY-FILE';
/** An OFX 2.x XML document: a processing instruction, then the `<OFX>` root. */
const OFX_XML_DECLARATION = /<\?OFX[\s?]/i;
/** An OFX 1.x SGML document starts with its `OFXHEADER:100` line. */
const OFX_SGML_HEADER = /^\s*OFXHEADER\s*[:=]/i;
/** The root element, `<OFX>` or `<OFX ...>`, never `<OFXEXTENSION>`. */
const OFX_ROOT = /<OFX[\s>]/i;

export function sniffXmlImportKind(head: Uint8Array): XmlImportKind {
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) {
    return 'kmymoney';
  }
  const bytes = head.subarray(0, XML_SNIFF_BYTES);
  const start =
    bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
      ? 3
      : 0;
  // Lenient: a malformed sequence becomes U+FFFD instead of throwing, and a
  // multi-byte character cut at the slice boundary only damages the last char.
  const text = new TextDecoder('utf-8').decode(bytes.subarray(start));
  if (text.includes(KMYMONEY_ROOT) || text.includes(KMYMONEY_DOCTYPE)) {
    return 'kmymoney';
  }
  if (
    OFX_SGML_HEADER.test(text) ||
    OFX_XML_DECLARATION.test(text) ||
    OFX_ROOT.test(text)
  ) {
    return 'ofx';
  }
  return 'unknown';
}

/** The first `XML_SNIFF_BYTES` of a file, and nothing more. */
export async function readXmlHead(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, XML_SNIFF_BYTES).arrayBuffer());
}
