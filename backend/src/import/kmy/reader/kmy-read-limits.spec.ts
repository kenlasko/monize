import { gzipSync } from "zlib";
import {
  kmyAccount,
  kmyFile,
  kmySplit,
  kmyTransaction,
  kmyTxId,
} from "../__fixtures__/kmy-xml-builders";
import {
  KmyCorruptFileError,
  KmyTooManyRecordsError,
  KmyXmlTooLargeError,
} from "../model/kmy-errors";
import { openKmyContainer } from "./kmy-container";
import { readKmyFile } from "./kmy-read-file";

/**
 * B2: a small upload must not be able to cost the server gigabytes or
 * seconds. Each bound of `kmy-limits.ts` is checked while the document is
 * read; the bounds are lowered here so a refusal can be shown on a small
 * document.
 */
jest.mock("./kmy-limits", () => ({
  ...jest.requireActual("./kmy-limits"),
  KMY_MAX_RECORDS: 40,
  KMY_MAX_ELEMENTS: 60,
  KMY_MAX_SPLITS_PER_TRANSACTION: 3,
  KMY_MAX_ATTRIBUTE_CHARS: 100,
}));

const read = (xml: string | Buffer, maxXmlBytes = 64 * 1024 * 1024) =>
  readKmyFile({
    bytes: Buffer.isBuffer(xml) ? xml : Buffer.from(xml),
    filename: "f.kmy",
    maxXmlBytes,
  });

const splitPair = (n: number) =>
  kmyTransaction(
    [
      kmySplit({ id: "S0001", account: "A000001" }),
      kmySplit({ id: "S0002", account: "A000001" }),
    ],
    { id: kmyTxId(n) },
  );

describe("the reader's bounds (B2, kmy-limits.ts)", () => {
  it("stops inflating at the first chunk past the byte bound", async () => {
    const limit = 256 * 1024;
    const bomb = gzipSync(
      Buffer.concat([
        Buffer.from("<KMYMONEY-FILE>"),
        Buffer.alloc(64 * 1024 * 1024, 0x20),
      ]),
    );
    expect(bomb.length).toBeLessThan(128 * 1024);
    const { chunks } = openKmyContainer(bomb, limit);
    let handed = 0;
    await expect(
      (async () => {
        for await (const chunk of chunks) {
          handed += chunk.length;
        }
      })(),
    ).rejects.toThrow(KmyXmlTooLargeError);
    // Never more than the bound reached the tokenizer: 64 MiB was never inflated.
    expect(handed).toBeLessThanOrEqual(limit);
  });

  it("refuses more records than KMY_MAX_RECORDS, as they arrive", async () => {
    const many = Array.from({ length: 20 }, (_, i) => splitPair(i + 1));
    await expect(
      read(kmyFile({ accounts: [kmyAccount()], transactions: many })),
    ).rejects.toThrow(KmyTooManyRecordsError);
    // Under the bound the same shape reads.
    await expect(
      read(
        kmyFile({ accounts: [kmyAccount()], transactions: many.slice(0, 5) }),
      ),
    ).resolves.toBeDefined();
  });

  it("refuses more elements than KMY_MAX_ELEMENTS, kept or not", async () => {
    const empties = "<X/>".repeat(80);
    await expect(
      read(`<KMYMONEY-FILE>${empties}</KMYMONEY-FILE>`),
    ).rejects.toThrow(KmyTooManyRecordsError);
  });

  it("refuses a transaction with more splits than KMY_MAX_SPLITS_PER_TRANSACTION", async () => {
    const wide = kmyTransaction(
      Array.from({ length: 4 }, (_, i) =>
        kmySplit({ id: `S000${i + 1}`, account: "A000001" }),
      ),
    );
    await expect(
      read(kmyFile({ accounts: [kmyAccount()], transactions: [wide] })),
    ).rejects.toThrow(KmyTooManyRecordsError);
  });

  it("refuses an attribute value longer than KMY_MAX_ATTRIBUTE_CHARS", async () => {
    await expect(
      read(
        kmyFile({ accounts: [kmyAccount({ description: "d".repeat(150) })] }),
      ),
    ).rejects.toThrow(KmyTooManyRecordsError);
    await expect(
      read(
        kmyFile({ accounts: [kmyAccount({ description: "d".repeat(90) })] }),
      ),
    ).resolves.toBeDefined();
  });

  it("refuses a split on an account it has not read yet when the split arrives, not at the end", async () => {
    // The rest of the document is never well formed: the refusal names the
    // split, so it came before the end of the document did.
    const xml =
      '<KMYMONEY-FILE><ACCOUNTS/><TRANSACTIONS><TRANSACTION id="T1"><SPLITS>' +
      '<SPLIT account="A404" value="1/1" shares="1/1"/>' +
      "<UNCLOSED>";
    await expect(read(xml)).rejects.toThrow(
      /references an account that is not in the file/,
    );
    await expect(read(xml)).rejects.toThrow(KmyCorruptFileError);
  });

  it("hands the event loop back while it reads", async () => {
    const accounts = [kmyAccount()];
    const transactions = Array.from({ length: 6 }, (_, i) =>
      kmyTransaction([kmySplit({ account: "A000001" })], {
        id: kmyTxId(i + 1),
        memo: "m".repeat(90),
      }),
    );
    // Padding between elements: about 1.5 MiB, several yield intervals.
    const padded = kmyFile({ accounts, transactions }).replace(
      "<TRANSACTIONS>",
      `<TRANSACTIONS>${" ".repeat(1536 * 1024)}`,
    );
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 0);
    try {
      await read(padded);
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });
});
