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
/** Opens the container and reads the whole document, as the reader does. */
async function open(bytes: Buffer, limit = LIMIT) {
  const { container, chunks } = openKmyContainer(bytes, limit);
  const parts: Buffer[] = [];
  for await (const chunk of chunks) {
    parts.push(chunk);
  }
  return { container, xml: Buffer.concat(parts) };
}

describe("openKmyContainer", () => {
  it("row 1: fewer than 2 bytes is not a KMyMoney file", async () => {
    await expect(open(Buffer.alloc(0))).rejects.toThrow(
      KmyNotAKmyMoneyFileError,
    );
    await expect(open(Buffer.from("<"))).rejects.toThrow(
      KmyNotAKmyMoneyFileError,
    );
  });

  it("row 2: the SQLite header is refused", async () => {
    const sqlite = Buffer.concat([
      Buffer.from("SQLite format 3\0", "latin1"),
      Buffer.alloc(100),
    ]);
    await expect(open(sqlite)).rejects.toThrow(KmySqliteDatabaseError);
  });

  it("row 3: gzip is inflated and the document continues at row 6", async () => {
    const result = await open(gzipSync(Buffer.from(DOC)));
    expect(result.container).toBe("gzip");
    expect(result.xml.toString()).toBe(DOC);
  });

  it("row 3: a corrupt gzip stream is a corrupt file", async () => {
    const bad = gzipSync(Buffer.from(DOC));
    const broken = Buffer.concat([bad.subarray(0, 12), Buffer.from("zzzz")]);
    await expect(open(broken)).rejects.toThrow(KmyCorruptFileError);
  });

  it("row 3: a truncated gzip stream is a corrupt file", async () => {
    const good = gzipSync(Buffer.from(DOC));
    await expect(open(good.subarray(0, good.length - 12))).rejects.toThrow(
      KmyCorruptFileError,
    );
  });

  it("row 3: a gzip bomb over the bound is kmyXmlTooLarge", async () => {
    const bomb = gzipSync(
      Buffer.concat([Buffer.from(DOC), Buffer.alloc(4 * 1024 * 1024, 0x20)]),
    );
    expect(bomb.length).toBeLessThan(LIMIT);
    await expect(open(bomb)).rejects.toThrow(KmyXmlTooLargeError);
    await expect(open(bomb)).rejects.toThrow(/1 MB/);
  });

  it.each([
    ["PGP armour", Buffer.from("-----BEGIN PGP MESSAGE-----\n...")],
    ["old-format packet 85 01", Buffer.from([0x85, 0x01, 0x02, 0x03])],
    ["old-format packet 85 02", Buffer.from([0x85, 0x02, 0x02, 0x03])],
    ["a first byte with bit 7 set", Buffer.from([0xa3, 0x0d, 0x04, 0x09])],
    ["a UTF-8 lead that is not a BOM", Buffer.from([0xc3, 0xa9, 0x20])],
  ])("row 4: %s is encrypted", async (_name, bytes) => {
    await expect(open(bytes)).rejects.toThrow(KmyEncryptedFileError);
  });

  it("row 4: the UTF-8 BOM is not encryption", async () => {
    const result = await open(
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(DOC)]),
    );
    expect(result.container).toBe("xml");
  });

  it("row 5/6: plain XML passes, and the BOM is stripped", async () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(DOC),
    ]);
    expect((await open(withBom)).xml.toString()).toBe(DOC);
    expect((await open(Buffer.from(DOC))).xml.toString()).toBe(DOC);
  });

  it("row 6: a control first byte (not TAB/LF/CR) is the legacy binary format", async () => {
    await expect(open(Buffer.from([0x00, 0x01, 0x02, 0x03]))).rejects.toThrow(
      KmyLegacyBinaryFileError,
    );
    await expect(open(Buffer.from([0x1f, 0x09, 0x02, 0x03]))).rejects.toThrow(
      KmyLegacyBinaryFileError,
    );
  });

  it("row 6: TAB, LF and CR first bytes are fine", async () => {
    for (const lead of ["\t", "\n", "\r"]) {
      expect((await open(Buffer.from(lead + DOC))).container).toBe("xml");
    }
  });

  it("row 6: the KMyMoney magic text is the legacy binary format", async () => {
    await expect(open(Buffer.from("KMyMoney\0\0 binary"))).rejects.toThrow(
      KmyLegacyBinaryFileError,
    );
  });

  it("row 6 also applies after inflation", async () => {
    await expect(open(gzipSync(Buffer.from([0, 1, 2, 3])))).rejects.toThrow(
      KmyLegacyBinaryFileError,
    );
  });

  it("row 7: a template document has no KMYMONEY-FILE root", async () => {
    const template = Buffer.from(
      '<?xml version="1.0"?>\n<!DOCTYPE KMYMONEY-TEMPLATE>\n<kmymoney-account-template/>',
    );
    await expect(open(template)).rejects.toThrow(KmyNotAKmyMoneyFileError);
  });

  it("row 7: random text, and a root past the first 4096 bytes, are refused", async () => {
    await expect(open(Buffer.from("hello world, not xml"))).rejects.toThrow(
      KmyNotAKmyMoneyFileError,
    );
    const late = Buffer.from(`<!-- ${"x".repeat(4100)} -->\n<KMYMONEY-FILE/>`);
    await expect(open(late)).rejects.toThrow(KmyNotAKmyMoneyFileError);
    await expect(
      open(gzipSync(Buffer.from("plain text here"))),
    ).rejects.toThrow(KmyNotAKmyMoneyFileError);
  });

  it("a plain document over the bound is kmyXmlTooLarge", async () => {
    await expect(open(Buffer.from(DOC), DOC.length - 1)).rejects.toThrow(
      KmyXmlTooLargeError,
    );
    expect((await open(Buffer.from(DOC), DOC.length)).container).toBe("xml");
  });

  it("does not mutate the input", async () => {
    const input = Buffer.from(DOC);
    const copy = Buffer.from(input);
    await open(input);
    expect(input.equals(copy)).toBe(true);
  });
});
