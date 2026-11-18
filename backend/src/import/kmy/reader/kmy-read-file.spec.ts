import { gzipSync } from "zlib";
import {
  kmyAccount,
  kmyElement,
  kmyFile,
  kmyPayee,
  kmySplit,
  kmyTransaction,
  toKmyBytes,
} from "../__fixtures__/kmy-xml-builders";
import { KMY_FIXTURES, readKmyFixture } from "../__fixtures__/kmy-fixtures";
import type { KmyFixtureName } from "../__fixtures__/kmy-fixtures";
import {
  KmyAnonymizedFileError,
  KmyCorruptFileError,
  KmyEncryptedFileError,
  KmyImportError,
  KmyLegacyBinaryFileError,
  KmyNotAKmyMoneyFileError,
  KmySqliteDatabaseError,
  KmyXmlTooLargeError,
} from "../model/kmy-errors";
import { add, rational, ZERO } from "../model/kmy-rational";
import { readKmyFile } from "./kmy-read-file";

const LIMIT = 300 * 1024 * 1024;

function read(bytes: Buffer, filename = "file.kmy", maxXmlBytes = LIMIT) {
  return readKmyFile({ bytes, filename, maxXmlBytes });
}

const fixture = (name: KmyFixtureName) =>
  read(readKmyFixture(name), KMY_FIXTURES[name].file);

describe("readKmyFile", () => {
  describe.each(["syntheticKmy", "syntheticXml"] as const)(
    "the committed %s fixture",
    (name) => {
      const expected = KMY_FIXTURES[name];
      const file = fixture(name);

      it("reads the container and file information", () => {
        expect(file.fileInfo).toEqual({
          container: expected.container,
          fixVersion: 12,
          appVersion: "synthetic",
          creationDate: "2024-01-01",
          lastModified: "2024-05-01T12:00:00+00:00",
        });
        expect(file.baseCurrency).toBe("USD");
      });

      it("reads the section counts of the reference's section 18", () => {
        expect(file.accounts).toHaveLength(17);
        expect(file.accounts.filter((a) => a.isStandard)).toHaveLength(5);
        expect(file.transactions).toHaveLength(11);
        expect(file.schedules).toHaveLength(1);
        expect(file.securities).toHaveLength(1);
        expect(file.currencies).toHaveLength(2);
        expect(file.prices).toHaveLength(3);
        expect(file.counts).toEqual({
          reports: 0,
          budgets: 1,
          onlineJobs: 0,
          matchedTransactions: 0,
          onlineBankingAccounts: 0,
        });
        expect(file.institutions).toHaveLength(1);
        expect(file.payees).toHaveLength(2);
        expect(file.tags).toHaveLength(1);
        expect(file.readerWarnings).toEqual([]);
      });

      it("reads the Checking split values exactly", () => {
        const shares = file.transactions.flatMap((t) =>
          t.splits.filter((s) => s.account === "A000001").map((s) => s.shares),
        );
        expect(shares).toEqual([
          rational(5000n),
          rational(-241n, 2n),
          rational(100n),
          rational(-1100n),
          rational(-75n),
          rational(-1000n),
        ]);
        expect(shares.reduce(add, ZERO)).toEqual(rational(5609n, 2n));
      });

      it("reads accounts, payees, schedule, security and prices", () => {
        const checking = file.accounts.find((a) => a.id === "A000001");
        expect(checking).toMatchObject({
          name: "Checking",
          institutionId: "I000001",
          number: "000123",
          description: "Main account\nsecond line of notes",
          lastReconciled: "2024-01-31",
          reconciliations: [{ date: "2024-01-31", value: rational(7759n, 2n) }],
        });
        expect(checking?.kvp.get("iban")).toBe("XX00EXAMPLE0000000000000");
        expect(
          file.accounts.find((a) => a.id === "A000013")?.kvp.get("mm-closed"),
        ).toBe("yes");
        expect(file.payees.map((p) => p.match.kind)).toEqual([
          "disabled",
          "key",
        ]);
        expect(file.payees[1]).toMatchObject({
          defaultAccountId: "A000008",
          match: { ignoreCase: true, keys: ["CITY POWER"] },
        });
        expect(file.schedules[0]).toMatchObject({
          id: "SCH000001",
          occurrence: 32,
          weekendOption: 1,
          lastPayment: "2024-02-01",
        });
        expect(file.schedules[0].template?.postDate).toBe("2024-03-01");
        expect(file.securities[0]).toMatchObject({
          symbol: "EXC",
          saf: 1000n,
          tradingCurrency: "USD",
        });
        const cross = file.transactions[4].splits[1];
        expect(cross).toMatchObject({
          value: rational(1100n),
          shares: rational(1000n),
          price: rational(11n, 10n),
        });
        const sell = file.transactions[10].splits[1];
        expect(sell).toMatchObject({ action: "Buy", shares: rational(-5n) });
        expect(file.transactions[0].splits[0]).toMatchObject({
          reconcileFlag: 2,
          reconcileDate: "2024-01-31",
        });
        expect(file.transactions[2].splits[1].tags).toEqual(["G000001"]);
      });
    },
  );

  it("returns equal raw models for the two committed files, container aside", () => {
    const gz = fixture("syntheticKmy");
    const xml = fixture("syntheticXml");
    expect(gz.fileInfo.container).toBe("gzip");
    expect(xml.fileInfo.container).toBe("xml");
    expect({ ...gz, fileInfo: { ...gz.fileInfo, container: "xml" } }).toEqual(
      xml,
    );
  });

  it("reads equal models from independent reads of the same bytes", () => {
    expect(fixture("syntheticKmy")).toEqual(fixture("syntheticKmy"));
  });

  it("does not mutate the uploaded bytes", () => {
    const bytes = readKmyFixture("syntheticXml");
    const copy = Buffer.from(bytes);
    read(bytes);
    expect(bytes.equals(copy)).toBe(true);
  });

  describe("refusals", () => {
    const doc = kmyFile({ accounts: [kmyAccount()] });

    it.each([
      ["a one-byte file", Buffer.from("<"), KmyNotAKmyMoneyFileError],
      [
        "a SQLite database",
        Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(64)]),
        KmySqliteDatabaseError,
      ],
      [
        "PGP armour",
        Buffer.from("-----BEGIN PGP MESSAGE-----\n"),
        KmyEncryptedFileError,
      ],
      [
        "binary 0.8 data",
        Buffer.from([0, 1, 2, 3, 4]),
        KmyLegacyBinaryFileError,
      ],
      [
        "a category template",
        Buffer.from("<KMYMONEY-TEMPLATE/>"),
        KmyNotAKmyMoneyFileError,
      ],
      [
        "corrupt gzip",
        Buffer.from([0x1f, 0x8b, 8, 0, 1, 2, 3]),
        KmyCorruptFileError,
      ],
    ])("%s", (_name, bytes, error) => {
      expect(() => read(bytes)).toThrow(error);
    });

    it("an inflated size over the bound", () => {
      expect(() =>
        read(
          gzipSync(Buffer.alloc(2 * 1024 * 1024, 0x20)),
          "f.kmy",
          1024 * 1024,
        ),
      ).toThrow(KmyXmlTooLargeError);
      expect(() => read(Buffer.from(doc), "f.xml", 100)).toThrow(
        KmyXmlTooLargeError,
      );
    });

    it("a filename ending .anon.xml, in any case", () => {
      expect(() => read(Buffer.from(doc), "backup.ANON.xml")).toThrow(
        KmyAnonymizedFileError,
      );
    });

    it("every account and payee named by its own id", () => {
      const anonymized = kmyFile({
        accounts: [
          kmyAccount({ id: "A000001", name: "A000001" }),
          kmyAccount({ id: "A000002", name: "A000002", type: 13 }),
        ],
        payees: [kmyPayee({ id: "P000001", name: "P000001" })],
      });
      expect(() => read(Buffer.from(anonymized))).toThrow(
        KmyAnonymizedFileError,
      );
    });

    it("is not anonymized when one name differs, a payee differs, or there is no account", () => {
      const partly = kmyFile({
        accounts: [
          kmyAccount({ id: "A000001", name: "A000001" }),
          kmyAccount({ id: "A000002", name: "Real" }),
        ],
      });
      expect(() => read(Buffer.from(partly))).not.toThrow();
      const payee = kmyFile({
        accounts: [kmyAccount({ id: "A000001", name: "A000001" })],
        payees: [kmyPayee({ id: "P000001", name: "Corner Market" })],
      });
      expect(() => read(Buffer.from(payee))).not.toThrow();
      expect(() => read(Buffer.from(kmyFile()))).not.toThrow();
    });

    it.each([
      [
        "a root that is not KMYMONEY-FILE in the first 4 KB",
        "<!-- <KMYMONEY-FILE> --><OTHER/>",
      ],
      ["an unclosed element", "<KMYMONEY-FILE><ACCOUNTS></KMYMONEY-FILE>"],
      [
        "a mismatched close tag",
        "<KMYMONEY-FILE><ACCOUNTS></PAYEES></KMYMONEY-FILE>",
      ],
      ["a truncated document", '<KMYMONEY-FILE><ACCOUNTS><ACCOUNT id="A1" '],
      [
        "an unknown split account",
        kmyFile({
          accounts: [kmyAccount()],
          transactions: [kmyTransaction([kmySplit({ account: "A404" })])],
        }),
      ],
      [
        "a split with opposite signs",
        kmyFile({
          accounts: [kmyAccount()],
          transactions: [
            kmyTransaction([kmySplit({ value: "1/1", shares: "-1/1" })]),
          ],
        }),
      ],
      [
        "a zero denominator",
        kmyFile({
          accounts: [kmyAccount()],
          transactions: [kmyTransaction([kmySplit({ value: "1/0" })])],
        }),
      ],
    ])("%s is a corrupt file", (_name, xml) => {
      expect(() => read(Buffer.from(xml))).toThrow(KmyCorruptFileError);
    });

    it("elements nested beyond 64 levels are a corrupt file", () => {
      const open = Array.from({ length: 70 }, (_, i) => `<N${i}>`).join("");
      const close = Array.from({ length: 70 }, (_, i) => `</N${69 - i}>`).join(
        "",
      );
      expect(() =>
        read(Buffer.from(`<KMYMONEY-FILE>${open}${close}</KMYMONEY-FILE>`)),
      ).toThrow(KmyCorruptFileError);
    });

    it("throws KmyImportError subclasses only, wrapping anything unexpected", () => {
      const hostile = new Proxy(Buffer.from(doc), {
        get(target, prop, receiver) {
          if (prop === "subarray") {
            throw new TypeError("boom");
          }
          return Reflect.get(target, prop, receiver);
        },
      });
      let thrown: unknown;
      try {
        read(hostile);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(KmyCorruptFileError);
      expect(thrown).toBeInstanceOf(KmyImportError);
    });
  });

  describe("input forms", () => {
    const xml = kmyFile({ accounts: [kmyAccount()] });

    it("reads gzip and plain, with a UTF-8 BOM", () => {
      expect(read(toKmyBytes(xml, "gzip")).fileInfo.container).toBe("gzip");
      const bom = Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(xml),
      ]);
      expect(read(bom).fileInfo.container).toBe("xml");
    });

    it("drops control bytes and stray continuation bytes before tokenizing", () => {
      const marked = Buffer.from(
        kmyFile({ accounts: [kmyAccount({ name: "Che#ck" })] }),
      );
      const at = marked.indexOf("#");
      const dirty = Buffer.concat([
        marked.subarray(0, at),
        Buffer.from([0x01, 0xa9, 0x00]),
        marked.subarray(at + 1),
      ]);
      const account = read(dirty).accounts.find((a) => !a.isStandard);
      expect(account?.name).toBe("Check");
    });

    it("decodes non-ASCII names", () => {
      const file = read(
        Buffer.from(kmyFile({ accounts: [kmyAccount({ name: "Café €" })] })),
      );
      expect(file.accounts.find((a) => !a.isStandard)?.name).toBe("Café €");
    });

    it("counts ordinals in document order before filtering", () => {
      const file = read(
        Buffer.from(
          kmyFile({
            accounts: [
              kmyAccount({ id: "A1" }),
              kmyAccount({ id: "A2", name: "Two" }),
            ],
            transactions: [
              kmyTransaction([kmySplit({ account: "A1" })], { id: "T1" }),
              kmyTransaction([kmySplit({ account: "A2" })], { id: "T2" }),
            ],
          }),
        ),
      );
      expect(file.accounts.map((a) => a.ordinal)).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]);
      expect(file.transactions.map((t) => t.ordinal)).toEqual([1, 2]);
    });

    it("does not read a REPORT's ACCOUNT, PAYEE or TAG as real ones", () => {
      const file = read(
        Buffer.from(
          kmyFile({
            accounts: [kmyAccount()],
            reports: [
              kmyElement(
                "REPORT",
                { id: "R1" },
                kmyElement("ACCOUNT", { id: "A404" }),
              ),
            ],
          }),
        ),
      );
      expect(file.accounts).toHaveLength(6);
      expect(file.counts.reports).toBe(1);
    });
  });
});
