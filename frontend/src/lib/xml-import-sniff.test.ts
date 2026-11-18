import { describe, it, expect } from 'vitest';
import { sniffXmlImportKind, readXmlHead, XML_SNIFF_BYTES } from './xml-import-sniff';

const enc = (text: string) => new TextEncoder().encode(text);
const KMY_BODY = '<!DOCTYPE KMYMONEY-FILE>\n<KMYMONEY-FILE>\n <FILEINFO/>\n</KMYMONEY-FILE>\n';
const OFX_SGML =
  'OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\n\n<OFX>\n<BANKMSGSRSV1><STMTTRNRS></STMTTRNRS></BANKMSGSRSV1>\n</OFX>\n';
const OFX_XML =
  '<?xml version="1.0" encoding="UTF-8"?>\n<?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>\n<OFX>\n<BANKMSGSRSV1/>\n</OFX>\n';

describe('sniffXmlImportKind', () => {
  const cases: Array<[string, Uint8Array, 'kmymoney' | 'ofx' | 'unknown']> = [
    ['KMyMoney XML with a declaration', enc(`<?xml version="1.0" encoding="utf-8"?>\n${KMY_BODY}`), 'kmymoney'],
    ['KMyMoney XML without a declaration', enc(KMY_BODY), 'kmymoney'],
    ['KMyMoney XML after a UTF-8 BOM', new Uint8Array([0xef, 0xbb, 0xbf, ...enc(KMY_BODY)]), 'kmymoney'],
    ['KMyMoney XML after leading whitespace', enc(`\n  \t${KMY_BODY}`), 'kmymoney'],
    ['a KMyMoney root with no doctype', enc('<KMYMONEY-FILE></KMYMONEY-FILE>'), 'kmymoney'],
    ['a KMyMoney doctype alone', enc('<!DOCTYPE KMYMONEY-FILE>'), 'kmymoney'],
    ['gzip bytes (a .kmy saved under an .xml name)', new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00]), 'kmymoney'],
    ['gzip magic and nothing else', new Uint8Array([0x1f, 0x8b]), 'kmymoney'],
    ['OFX 1.x SGML header saved as .xml', enc(OFX_SGML), 'ofx'],
    ['OFX 1.x header after a BOM and blank lines', new Uint8Array([0xef, 0xbb, 0xbf, ...enc(`\r\n\r\n${OFX_SGML}`)]), 'ofx'],
    ['OFX 2.x XML', enc(OFX_XML), 'ofx'],
    ['OFX 2.x without the processing instruction', enc('<?xml version="1.0"?>\n<OFX>\n</OFX>'), 'ofx'],
    ['an OFX root with attributes', enc('<OFX xmlns="x"></OFX>'), 'ofx'],
    ['lower-case OFX tags', enc('<ofx><bankmsgsrsv1/></ofx>'), 'ofx'],
    ['an SVG', enc('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'), 'unknown'],
    [
      'a camt.053 bank statement',
      enc('<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt/></Document>'),
      'unknown',
    ],
    ['an element merely starting with OFX', enc('<?xml version="1.0"?><OFXEXTENSION/>'), 'unknown'],
    ['an empty file', new Uint8Array(0), 'unknown'],
    ['one byte', new Uint8Array([0x3c]), 'unknown'],
    ['whitespace only', enc('   \n  '), 'unknown'],
    ['binary garbage', new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x10]), 'unknown'],
  ];

  it.each(cases)('%s', (_name, bytes, expected) => {
    expect(sniffXmlImportKind(bytes)).toBe(expected);
  });

  it('reads a file shorter than the slice', () => {
    expect(sniffXmlImportKind(enc('<KMYMONEY-FILE'))).toBe('kmymoney');
  });

  it('finds the root inside the slice', () => {
    const filler = '<!-- ' + 'x'.repeat(XML_SNIFF_BYTES - 100) + ' -->\n';
    expect(sniffXmlImportKind(enc(filler + KMY_BODY))).toBe('kmymoney');
  });

  it('does not look past the slice: a doctype that appears only after it is unknown', () => {
    const filler = '<!-- ' + 'x'.repeat(XML_SNIFF_BYTES) + ' -->\n';
    expect(sniffXmlImportKind(enc(filler + KMY_BODY))).toBe('unknown');
  });

  it('does not decide on an OFX root that appears only after the slice', () => {
    const filler = '<!-- ' + 'x'.repeat(XML_SNIFF_BYTES) + ' -->\n';
    expect(sniffXmlImportKind(enc(`${filler}<OFX></OFX>`))).toBe('unknown');
  });

  it('survives a multi-byte character cut at the slice boundary', () => {
    const bytes = new Uint8Array(XML_SNIFF_BYTES);
    bytes.fill(0x20);
    bytes.set(enc('<OFX>'), 0);
    bytes[XML_SNIFF_BYTES - 1] = 0xe2;
    expect(sniffXmlImportKind(bytes)).toBe('ofx');
  });
});

describe('readXmlHead', () => {
  it('reads only the first slice of a larger file', async () => {
    const file = new File([new Uint8Array(XML_SNIFF_BYTES * 3).fill(0x41)], 'big.xml');
    expect((await readXmlHead(file)).length).toBe(XML_SNIFF_BYTES);
  });

  it('reads a file shorter than the slice whole', async () => {
    const file = new File([enc('<OFX>')], 'small.xml');
    expect(Array.from(await readXmlHead(file))).toEqual(Array.from(enc('<OFX>')));
  });
});
