import { gzipSync } from "zlib";
import {
  KmyCorruptFileError,
  KmyEncryptedFileError,
  KmyLegacyBinaryFileError,
  KmyNotAKmyMoneyFileError,
  KmySqliteDatabaseError,
  KmyXmlTooLargeError,
} from "../model/kmy-errors";
import { openKmyContainer } from "./kmy-container";

const LIMIT = 1024 * 1024;
const DOC =
  '<?xml version="1.0"?>\n<!DOCTYPE KMYMONEY-FILE>\n<KMYMONEY-FILE/>\n';
const open = (bytes: Buffer, limit = LIMIT) => openKmyContainer(bytes, limit);

describe("openKmyContainer", () => {
  it("row 1: fewer than 2 bytes is not a KMyMoney file", () => {
    expect(() => open(Buffer.alloc(0))).toThrow(KmyNotAKmyMoneyFileError);
    expect(() => open(Buffer.from("<"))).toThrow(KmyNotAKmyMoneyFileError);
  });

  it("row 2: the SQLite header is refused", () => {
    const sqlite = Buffer.concat([
      Buffer.from("SQLite format 3\0", "latin1"),
      Buffer.alloc(100),
    ]);
    expect(() => open(sqlite)).toThrow(KmySqliteDatabaseError);
  });

  it("row 3: gzip is inflated and the document continues at row 6", () => {
    const result = open(gzipSync(Buffer.from(DOC)));
    expect(result.container).toBe("gzip");
    expect(result.xml.toString()).toBe(DOC);
  });

  it("row 3: a corrupt gzip stream is a corrupt file", () => {
    const bad = gzipSync(Buffer.from(DOC));
    const broken = Buffer.concat([bad.subarray(0, 12), Buffer.from("zzzz")]);
    expect(() => open(broken)).toThrow(KmyCorruptFileError);
  });

  it("row 3: a truncated gzip stream is a corrupt file", () => {
    const good = gzipSync(Buffer.from(DOC));
    expect(() => open(good.subarray(0, good.length - 12))).toThrow(
      KmyCorruptFileError,
    );
  });

  it("row 3: a gzip bomb over the bound is kmyXmlTooLarge", () => {
    const bomb = gzipSync(Buffer.alloc(4 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(LIMIT);
    expect(() => open(bomb)).toThrow(KmyXmlTooLargeError);
    expect(() => open(bomb)).toThrow(/1 MB/);
  });

  it.each([
    ["PGP armour", Buffer.from("-----BEGIN PGP MESSAGE-----\n...")],
    ["old-format packet 85 01", Buffer.from([0x85, 0x01, 0x02, 0x03])],
    ["old-format packet 85 02", Buffer.from([0x85, 0x02, 0x02, 0x03])],
    ["a first byte with bit 7 set", Buffer.from([0xa3, 0x0d, 0x04, 0x09])],
    ["a UTF-8 lead that is not a BOM", Buffer.from([0xc3, 0xa9, 0x20])],
  ])("row 4: %s is encrypted", (_name, bytes) => {
    expect(() => open(bytes)).toThrow(KmyEncryptedFileError);
  });

  it("row 4: the UTF-8 BOM is not encryption", () => {
    const result = open(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(DOC)]),
    );
    expect(result.container).toBe("xml");
  });

  it("row 5/6: plain XML passes, and the BOM is stripped", () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(DOC),
    ]);
    expect(open(withBom).xml.toString()).toBe(DOC);
    expect(open(Buffer.from(DOC)).xml.toString()).toBe(DOC);
  });

  it("row 6: a control first byte (not TAB/LF/CR) is the legacy binary format", () => {
    expect(() => open(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toThrow(
      KmyLegacyBinaryFileError,
    );
    expect(() => open(Buffer.from([0x1f, 0x09, 0x02, 0x03]))).toThrow(
      KmyLegacyBinaryFileError,
    );
  });

  it("row 6: TAB, LF and CR first bytes are fine", () => {
    for (const lead of ["\t", "\n", "\r"]) {
      expect(open(Buffer.from(lead + DOC)).container).toBe("xml");
    }
  });

  it("row 6: the KMyMoney magic text is the legacy binary format", () => {
    expect(() => open(Buffer.from("KMyMoney\0\0 binary"))).toThrow(
      KmyLegacyBinaryFileError,
    );
  });

  it("row 6 also applies after inflation", () => {
    expect(() => open(gzipSync(Buffer.from([0, 1, 2, 3])))).toThrow(
      KmyLegacyBinaryFileError,
    );
  });

  it("row 7: a template document has no KMYMONEY-FILE root", () => {
    const template = Buffer.from(
      '<?xml version="1.0"?>\n<!DOCTYPE KMYMONEY-TEMPLATE>\n<kmymoney-account-template/>',
    );
    expect(() => open(template)).toThrow(KmyNotAKmyMoneyFileError);
  });

  it("row 7: random text, and a root past the first 4096 bytes, are refused", () => {
    expect(() => open(Buffer.from("hello world, not xml"))).toThrow(
      KmyNotAKmyMoneyFileError,
    );
    const late = Buffer.from(`<!-- ${"x".repeat(4100)} -->\n<KMYMONEY-FILE/>`);
    expect(() => open(late)).toThrow(KmyNotAKmyMoneyFileError);
    expect(() => open(gzipSync(Buffer.from("plain text here")))).toThrow(
      KmyNotAKmyMoneyFileError,
    );
  });

  it("a plain document over the bound is kmyXmlTooLarge", () => {
    expect(() => open(Buffer.from(DOC), DOC.length - 1)).toThrow(
      KmyXmlTooLargeError,
    );
    expect(open(Buffer.from(DOC), DOC.length).container).toBe("xml");
  });

  it("does not mutate the input", () => {
    const input = Buffer.from(DOC);
    const copy = Buffer.from(input);
    open(input);
    expect(input.equals(copy)).toBe(true);
  });
});
