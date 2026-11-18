import {
  kmyAccount,
  kmyCurrency,
  kmyElement,
  kmyFile,
  kmyInstitution,
  kmyPayee,
  kmyPrice,
  kmyPricePair,
  kmySchedule,
  kmySecurity,
  kmySplit,
  kmySplitWith,
  kmyTag,
  kmyTransaction,
  kmyTxId,
} from "../__fixtures__/kmy-xml-builders";
import { KmyCorruptFileError } from "../model/kmy-errors";
import { rational } from "../model/kmy-rational";
import type { KmyRawFile } from "../model/kmy-raw";
import { KmyRawCollector } from "./kmy-raw-collector";
import { readKmyBool, readKmyDate, readKmyUint } from "./kmy-reader-values";
import { tokenizeKmyXml } from "./kmy-xml-tokenize";

function collect(xml: string): KmyRawFile {
  const collector = new KmyRawCollector();
  tokenizeKmyXml(Buffer.from(xml, "utf8"), collector);
  return collector.finish("xml");
}

const checking = kmyAccount();
const category = kmyAccount({
  id: "A000002",
  parentaccount: "AStd::Expense",
  type: 13,
  name: "Food",
});

describe("attribute decoding", () => {
  it("accepts real calendar dates only", () => {
    expect(readKmyDate("2024-02-29")).toBe("2024-02-29");
    expect(readKmyDate("2023-02-29")).toBeNull();
    expect(readKmyDate("2024-13-01")).toBeNull();
    expect(readKmyDate("2024-1-1")).toBeNull();
    expect(readKmyDate("2024-05-01T12:00:00")).toBeNull();
    expect(readKmyDate("")).toBeNull();
    expect(readKmyDate(undefined)).toBeNull();
  });

  it("reads booleans case-insensitively with a default", () => {
    for (const yes of ["1", "on", "TRUE", "Yes"]) {
      expect(readKmyBool(yes, false)).toBe(true);
    }
    for (const no of ["0", "off", "False", "NO"]) {
      expect(readKmyBool(no, true)).toBe(false);
    }
    expect(readKmyBool("maybe", true)).toBe(true);
    expect(readKmyBool(undefined, false)).toBe(false);
  });

  it("reads unsigned integers with a fallback", () => {
    expect(readKmyUint("12", 0)).toBe(12);
    expect(readKmyUint("-1", 7)).toBe(7);
    expect(readKmyUint("x", 7)).toBe(7);
    expect(readKmyUint(undefined, 7)).toBe(7);
  });
});

describe("KmyRawCollector", () => {
  describe("FILEINFO and file-level KVP", () => {
    it("reads the current form", () => {
      const file = collect(kmyFile());
      expect(file.fileInfo).toEqual({
        container: "xml",
        fixVersion: 12,
        appVersion: "synthetic",
        creationDate: "2024-01-01",
        lastModified: "2024-05-01T12:00:00+00:00",
      });
      expect(file.baseCurrency).toBe("USD");
    });

    it.each([
      ['<FIXVERSION id="12"/>', 12],
      ['<FIXVERSION date="4"/>', 4],
      ['<FIXVERSION date="" id="9"/>', 9],
      ['<FIXVERSION date=""/>', 5],
      ['<FIXVERSION id=""/>', 5],
      ["<FIXVERSION/>", 5],
      ['<FIXVERSION date="2"/>', 3],
      ['<FIXVERSION id="2"/>', 3],
      ["", 12],
    ])("fix version of %s is %d", (element, expected) => {
      const info = `<FILEINFO><CREATION_DATE date=""/>${element}</FILEINFO>`;
      const file = collect(kmyFile({ fileInfo: info }));
      expect(file.fileInfo.fixVersion).toBe(expected);
      expect(file.fileInfo.creationDate).toBeNull();
      expect(file.fileInfo.appVersion).toBeNull();
      expect(file.fileInfo.lastModified).toBeNull();
    });

    it("reads a date-only LAST_MODIFIED_DATE as written", () => {
      const info =
        '<FILEINFO><LAST_MODIFIED_DATE date="2017-10-20"/></FILEINFO>';
      expect(collect(kmyFile({ fileInfo: info })).fileInfo.lastModified).toBe(
        "2017-10-20",
      );
    });

    it("has no base currency when the pair is missing or empty", () => {
      expect(
        collect(kmyFile({ kvp: { "kmm-baseCurrency": "" } })).baseCurrency,
      ).toBeNull();
    });
  });

  describe("institutions, payees, tags, cost centers", () => {
    it("reads institutions with their account ids", () => {
      const file = collect(
        kmyFile({
          institutions: [kmyInstitution({}, ["A000001", "A000009"])],
        }),
      );
      expect(file.institutions).toEqual([
        {
          ordinal: 1,
          id: "I000001",
          name: "Example Bank",
          accountIds: ["A000001", "A000009"],
        },
      ]);
    });

    describe("payees (reference 10.1)", () => {
      const only = (
        overrides: Record<string, string | number>,
        children?: string,
      ) =>
        collect(
          kmyFile({ payees: [kmyPayee({ id: "P1", ...overrides }, children)] }),
        ).payees[0];

      it("reads a plain payee with matching disabled and no details", () => {
        expect(only({ name: "plain" })).toEqual({
          ordinal: 1,
          id: "P1",
          name: "plain",
          match: { kind: "disabled", ignoreCase: false, keys: [] },
          defaultAccountId: null,
          notes: "",
          email: "",
          reference: "",
          address: {
            street: "",
            city: "",
            state: "",
            postcode: "",
            telephone: "",
          },
          hasIdentifiers: false,
          hasLinkPattern: false,
        });
      });

      it("reads the four matching modes", () => {
        expect(only({ matchingenabled: 1, usingmatchkey: 0 }).match.kind).toBe(
          "name",
        );
        expect(
          only({ matchingenabled: 1, usingmatchkey: 0, matchkey: "^$" }).match
            .kind,
        ).toBe("nameExact");
        expect(
          only({ matchingenabled: 1, usingmatchkey: 1, matchkey: "A\n" }).match
            .kind,
        ).toBe("key");
        expect(only({ matchingenabled: 0, usingmatchkey: 1 }).match.kind).toBe(
          "disabled",
        );
      });

      it("reads matching flags as unsigned integers: empty and text are 0, any other number true", () => {
        expect(only({ matchingenabled: "true" }).match.kind).toBe("disabled");
        expect(only({ matchingenabled: "" }).match.kind).toBe("disabled");
        expect(only({ matchingenabled: 2, usingmatchkey: 0 }).match.kind).toBe(
          "name",
        );
        expect(
          only({ matchingenabled: 1, usingmatchkey: "true" }).match.kind,
        ).toBe("name");
        expect(only({ matchingenabled: 1, matchignorecase: 7 }).match).toEqual({
          kind: "name",
          ignoreCase: true,
          keys: [],
        });
        expect(only({ matchingenabled: 1 }).match.ignoreCase).toBe(false);
      });

      it("splits keys on a line feed, drops the trailing empty one and keeps spaces inside keys", () => {
        const match = only({
          matchingenabled: 1,
          usingmatchkey: 1,
          matchkey: " A B \n\n   \nC;D\n",
        }).match;
        expect(match.keys).toEqual([" A B ", "C;D"]);
      });

      it("splits keys on ; only when the value holds no line feed (KMyMoney 4.8)", () => {
        expect(
          only({ matchingenabled: 1, usingmatchkey: 1, matchkey: "A;;  ;B" })
            .match.keys,
        ).toEqual(["A", "B"]);
      });

      it("reads a single key with its trailing line feed from the XML escape", () => {
        const file = collect(
          kmyFile({
            payees: [
              `<PAYEE id="P1" name="x" matchingenabled="1" usingmatchkey="1" matchkey="CITY POWER&#10;"/>`,
            ],
          }),
        );
        expect(file.payees[0].match.keys).toEqual(["CITY POWER"]);
      });

      it("reads the default account, notes, email and reference", () => {
        expect(
          only({
            defaultaccountid: "A000002",
            notes: " n ",
            email: "a@example.invalid",
            reference: "R",
          }),
        ).toMatchObject({
          defaultAccountId: "A000002",
          notes: " n ",
          email: "a@example.invalid",
          reference: "R",
        });
      });

      it("reads the address with the current names, untrimmed", () => {
        const { address } = only(
          {},
          kmyElement("ADDRESS", {
            street: "1 Main St\nSuite 2",
            city: " Springfield ",
            state: "IL",
            zip: "62701",
            telephone: "555 0100",
          }),
        );
        expect(address).toEqual({
          street: "1 Main St\nSuite 2",
          city: " Springfield ",
          state: "IL",
          postcode: "62701",
          telephone: "555 0100",
        });
      });

      it("falls back to the legacy address names (R2.4), taking the first non-empty", () => {
        expect(
          only(
            {},
            kmyElement("ADDRESS", {
              state: "",
              country: "",
              county: "Kent",
              zip: "",
              zipcode: "",
              postcode: "CT1",
            }),
          ).address,
        ).toMatchObject({ state: "Kent", postcode: "CT1" });
        expect(
          only(
            {},
            kmyElement("ADDRESS", {
              state: "",
              country: "UK",
              county: "Kent",
              zip: "Z1",
              zipcode: "Z2",
            }),
          ).address,
        ).toMatchObject({ state: "UK", postcode: "Z1" });
      });

      it("notes a payeeIdentifier child and a non-empty idpattern or urltemplate", () => {
        expect(
          only({}, kmyElement("payeeIdentifier", { id: "1" })).hasIdentifiers,
        ).toBe(true);
        expect(only({ idpattern: "\\d+" }).hasLinkPattern).toBe(true);
        expect(only({ urltemplate: "http://x/%1" }).hasLinkPattern).toBe(true);
        expect(only({ idpattern: "", urltemplate: "" }).hasLinkPattern).toBe(
          false,
        );
      });
    });

    it("reads tags and cost centers", () => {
      const file = collect(
        kmyFile({
          tags: [kmyTag(), kmyTag({ id: "G2", name: "old", closed: 1 })],
          costCenters: [kmyElement("COSTCENTER", { id: "C1", name: "Ops" })],
        }),
      );
      expect(file.tags).toEqual([
        { ordinal: 1, id: "G000001", name: "household", closed: false },
        { ordinal: 2, id: "G2", name: "old", closed: true },
      ]);
      expect(file.costCenters).toEqual([{ ordinal: 1, id: "C1", name: "Ops" }]);
    });

    it("counts ordinals before dropping an element without an id", () => {
      const file = collect(
        kmyFile({ payees: [kmyPayee({ id: "" }), kmyPayee({ id: "P2" })] }),
      );
      expect(file.payees.map((p) => [p.ordinal, p.id])).toEqual([[2, "P2"]]);
    });
  });

  describe("accounts", () => {
    it("reads every attribute, child and the standard roots", () => {
      const file = collect(
        kmyFile({
          accounts: [
            kmyAccount(
              {
                id: "A000001",
                institution: "I000001",
                lastreconciled: "2024-01-31",
                number: "000123",
                description: "line one\nline two",
              },
              {
                subaccounts: ["A000002"],
                reconciliations: [{ date: "2024-01-31", value: "7759/2" }],
                kvp: { iban: "XX00", "mm-closed": "yes" },
              },
            ),
            category,
          ],
        }),
      );
      expect(file.accounts).toHaveLength(7);
      expect(file.accounts.slice(0, 5).every((a) => a.isStandard)).toBe(true);
      expect(file.accounts[0]).toMatchObject({
        ordinal: 1,
        id: "AStd::Asset",
        parentId: null,
        opened: null,
        type: 9,
      });
      const account = file.accounts[5];
      expect(account).toEqual({
        ordinal: 6,
        id: "A000001",
        isStandard: false,
        parentId: "AStd::Asset",
        name: "Checking",
        type: 1,
        currency: "USD",
        institutionId: "I000001",
        opened: "2024-01-01",
        lastReconciled: "2024-01-31",
        number: "000123",
        description: "line one\nline two",
        subaccountIds: ["A000002"],
        reconciliations: [{ date: "2024-01-31", value: rational(7759n, 2n) }],
        kvp: new Map([
          ["iban", "XX00"],
          ["mm-closed", "yes"],
        ]),
        hasOnlineBanking: false,
      });
    });

    it("reads a missing or invalid type as 0 and a missing currency as null", () => {
      const file = collect(
        kmyFile({
          standardAccounts: false,
          accounts: [
            kmyAccount({ id: "A1", type: undefined, currency: undefined }),
            kmyAccount({ id: "A2", type: "abc", opened: "2023-02-30" }),
          ],
        }),
      );
      expect(file.accounts.map((a) => a.type)).toEqual([0, 0]);
      expect(file.accounts[0].currency).toBeNull();
      expect(file.accounts[1].opened).toBeNull();
    });

    it("folds legacy IBAN into iban (iban wins) and drops lastStatementDate", () => {
      const file = collect(
        kmyFile({
          standardAccounts: false,
          accounts: [
            kmyAccount(
              { id: "A1" },
              { kvp: { IBAN: "OLD", lastStatementDate: "2020-01-01" } },
            ),
            kmyAccount({ id: "A2" }, { kvp: { IBAN: "OLD", iban: "NEW" } }),
          ],
        }),
      );
      expect(file.accounts[0].kvp).toEqual(new Map([["iban", "OLD"]]));
      expect(file.accounts[1].kvp).toEqual(new Map([["iban", "NEW"]]));
    });

    it("reads the legacy reconciliationHistory only when no element exists", () => {
      const history = "2024-01-31:7759/2;bad;2024-02-29:100/1";
      const file = collect(
        kmyFile({
          standardAccounts: false,
          accounts: [
            kmyAccount(
              { id: "A1" },
              { kvp: { reconciliationHistory: history } },
            ),
            kmyAccount(
              { id: "A2" },
              {
                kvp: { reconciliationHistory: history },
                reconciliations: [{ date: "2024-03-01", value: "1/1" }],
              },
            ),
          ],
        }),
      );
      expect(file.accounts[0].reconciliations).toEqual([
        { date: "2024-01-31", value: rational(7759n, 2n) },
        { date: "2024-02-29", value: rational(100n) },
      ]);
      expect(file.accounts[1].reconciliations).toEqual([
        { date: "2024-03-01", value: rational(1n) },
      ]);
    });

    it("keeps no ONLINEBANKING attribute, only a flag and a count", () => {
      const file = collect(
        kmyFile({
          standardAccounts: false,
          accounts: [
            kmyAccount(
              { id: "A1" },
              {
                onlineBanking: { provider: "ofximporter", username: "secret" },
              },
            ),
            kmyAccount({ id: "A2" }),
          ],
        }),
      );
      expect(file.accounts.map((a) => a.hasOnlineBanking)).toEqual([
        true,
        false,
      ]);
      expect(file.counts.onlineBankingAccounts).toBe(1);
      expect(
        JSON.stringify([...file.accounts], (_k, v) =>
          typeof v === "bigint" ? String(v) : v,
        ),
      ).not.toContain("secret");
    });
  });

  describe("transactions", () => {
    const tx = (
      splits: string[],
      overrides = {},
      kvp?: Record<string, string>,
    ) => kmyTransaction(splits, overrides, kvp);

    it("reads transaction and split attributes, tags and KVPs", () => {
      const file = collect(
        kmyFile({
          accounts: [checking, category],
          transactions: [
            tx(
              [
                kmySplit({
                  payee: "P1",
                  reconcileflag: 2,
                  reconciledate: "2024-01-31",
                  value: "-241/2",
                  shares: "-241/2",
                  price: "1/1",
                  memo: "Weekly shop",
                  number: "1234",
                  bankid: "FITID",
                  costcenter: "C1",
                }),
                kmySplitWith(
                  { account: "A000002", value: "241/2", shares: "241/2" },
                  {
                    tags: ["G1", "G2"],
                    kvp: { "kmm-matched-tx": "&lt;x/&gt;" },
                  },
                ),
              ],
              { memo: "t", commodity: "EUR" },
              { Imported: "true" },
            ),
          ],
        }),
      );
      expect(file.transactions).toHaveLength(1);
      const t = file.transactions[0];
      expect(t).toMatchObject({
        ordinal: 1,
        id: kmyTxId(1),
        postDate: "2024-01-05",
        memo: "t",
        commodity: "EUR",
        kvp: new Map([["Imported", "true"]]),
      });
      expect(t.splits[0]).toEqual({
        ordinal: 1,
        account: "A000001",
        payee: "P1",
        value: rational(-241n, 2n),
        shares: rational(-241n, 2n),
        price: rational(1n),
        action: "",
        reconcileFlag: 2,
        reconcileDate: "2024-01-31",
        memo: "Weekly shop",
        number: "1234",
        bankId: "FITID",
        costCenter: "C1",
        tags: [],
        hasMatchedTransaction: false,
      });
      expect(t.splits[1]).toMatchObject({
        ordinal: 2,
        tags: ["G1", "G2"],
        hasMatchedTransaction: true,
        payee: null,
        costCenter: null,
      });
      expect(file.counts.matchedTransactions).toBe(1);
    });

    it("refuses a split with an empty account, as KMyMoney's readSplit does (m9)", () => {
      // KMyMoney checks the id against the accounts read so far before its
      // "Dropped split" branch could see an empty one, so the file is refused.
      expect(() =>
        collect(
          kmyFile({
            accounts: [checking, category],
            transactions: [
              tx([
                kmySplit({ account: "" }),
                kmySplit({ account: "A000001", value: "1/1", shares: "1/1" }),
                kmySplit({
                  account: "A000002",
                  value: "-1/1",
                  shares: "-1/1",
                }),
              ]),
            ],
          }),
        ),
      ).toThrow(KmyCorruptFileError);
    });

    it("keeps a transaction with no split, an empty memo and a bad date", () => {
      const file = collect(
        kmyFile({
          transactions: [tx([], { postdate: "2024-02-31", commodity: "" })],
        }),
      );
      expect(file.transactions[0]).toMatchObject({
        postDate: null,
        commodity: null,
        splits: [],
      });
    });

    it("reads a missing price as 0 and missing shares as 0", () => {
      const file = collect(
        kmyFile({
          accounts: [checking],
          transactions: [
            tx([
              kmySplit({ value: "5/1", shares: undefined, price: undefined }),
            ]),
          ],
        }),
      );
      const split = file.transactions[0].splits[0];
      expect(split.shares).toEqual(rational(0n));
      expect(split.price).toEqual(rational(0n));
    });

    it("turns an unparsable number into 0 with a reader warning", () => {
      const file = collect(
        kmyFile({
          accounts: [checking],
          transactions: [tx([kmySplit({ value: "abc", shares: "1,5" })])],
        }),
      );
      expect(file.transactions[0].splits[0].value).toEqual(rational(0n));
      expect(file.readerWarnings).toEqual([
        {
          code: "unparsableNumber",
          subject: "SPLIT@value",
          transactionOrdinal: 1,
        },
        {
          code: "unparsableNumber",
          subject: "SPLIT@shares",
          transactionOrdinal: 1,
        },
      ]);
    });

    it("turns the auto-calc sentinel in a posted split into 0 with a warning", () => {
      const file = collect(
        kmyFile({
          accounts: [checking],
          transactions: [
            tx([
              kmySplit({ value: "-9223372036854775807/100", shares: "0/1" }),
            ]),
          ],
        }),
      );
      expect(file.transactions[0].splits[0].value).toEqual(rational(0n));
      expect(file.readerWarnings).toEqual([
        {
          code: "autoCalcInPostedSplit",
          subject: "SPLIT@value",
          transactionOrdinal: 1,
        },
      ]);
    });

    it("refuses a zero denominator", () => {
      expect(() =>
        collect(
          kmyFile({
            accounts: [checking],
            transactions: [tx([kmySplit({ value: "1/0" })])],
          }),
        ),
      ).toThrow(KmyCorruptFileError);
    });

    it("refuses a split on an unknown account or on a standard root", () => {
      for (const account of ["A999999", "AStd::Asset"]) {
        expect(() =>
          collect(
            kmyFile({
              accounts: [checking],
              transactions: [tx([kmySplit({ account })])],
            }),
          ),
        ).toThrow(KmyCorruptFileError);
      }
    });

    it("accepts an account defined after the transactions section", () => {
      const xml = kmyFile({
        accounts: [checking],
        transactions: [tx([kmySplit()])],
      });
      expect(collect(xml).transactions).toHaveLength(1);
    });

    it("refuses opposite non-zero signs of shares and value, and allows a zero", () => {
      const bad = (value: string, shares: string) =>
        collect(
          kmyFile({
            accounts: [checking],
            transactions: [tx([kmySplit({ value, shares })])],
          }),
        );
      expect(() => bad("5/1", "-5/1")).toThrow(KmyCorruptFileError);
      expect(() => bad("-5/1", "5/1")).toThrow(KmyCorruptFileError);
      expect(() => bad("0/1", "-5/1")).not.toThrow();
      expect(() => bad("5/1", "0/1")).not.toThrow();
    });

    it("collapses a repeated (postdate, id) to the later one with a warning", () => {
      const file = collect(
        kmyFile({
          accounts: [checking],
          transactions: [
            tx([kmySplit()], { memo: "first" }),
            tx([kmySplit()], { id: kmyTxId(2) }),
            tx([kmySplit()], { memo: "second" }),
            tx([kmySplit()], { postdate: "2024-01-06", memo: "other day" }),
          ],
        }),
      );
      expect(file.transactions.map((t) => [t.ordinal, t.memo])).toEqual([
        [3, "second"],
        [2, ""],
        [4, "other day"],
      ]);
      expect(file.readerWarnings).toEqual([
        {
          code: "duplicateTransactionId",
          subject: kmyTxId(1),
          transactionOrdinal: 3,
        },
      ]);
    });
  });

  describe("schedules", () => {
    const templateSplit = (overrides = {}) =>
      kmySplit({ value: "-75/1", shares: "-75/1", ...overrides });

    it("reads the schedule, its template and the payments", () => {
      const file = collect(
        kmyFile({
          accounts: [checking],
          schedules: [
            kmySchedule([templateSplit({ payee: "P2" })], {
              fixed: 1,
              autoEnter: "yes",
              lastDayInMonth: 1,
              weekendOption: 2,
              occurenceMultiplier: 3,
            }),
          ],
        }),
      );
      expect(file.schedules).toHaveLength(1);
      expect(file.schedules[0]).toMatchObject({
        ordinal: 1,
        id: "SCH000001",
        name: "Bill",
        type: 1,
        occurrence: 32,
        multiplier: 3,
        paymentType: 1,
        startDate: "2024-02-01",
        endDate: null,
        lastPayment: "2024-02-01",
        fixed: true,
        autoEnter: true,
        lastDayInMonth: true,
        weekendOption: 2,
        payments: [],
      });
      expect(file.schedules[0].template).toMatchObject({
        postDate: "2024-03-01",
        commodity: "USD",
      });
      expect(file.schedules[0].template?.splits[0]).toMatchObject({
        ordinal: 1,
        payee: "P2",
        value: rational(-75n),
      });
    });

    it("reads a PAYMENTS date and PAYMENT children", () => {
      const xml = kmyFile({
        accounts: [checking],
        schedules: [
          kmyElement(
            "SCHEDULED_TX",
            { id: "S1", name: "x" },
            kmyElement("PAYMENTS", { date: "2024-01-01" }, [
              kmyElement("PAYMENT", { date: "2024-02-01" }),
              kmyElement("PAYMENT", { date: "bad" }),
            ]),
          ),
        ],
      });
      const [schedule] = collect(xml).schedules;
      expect(schedule.payments).toEqual(["2024-01-01", "2024-02-01"]);
      expect(schedule.template).toBeNull();
      expect(schedule.multiplier).toBe(1);
    });

    it("keeps the auto-calc amount of a template split", () => {
      const file = collect(
        kmyFile({
          accounts: [checking],
          schedules: [
            kmySchedule([
              templateSplit({
                value: "-9223372036854775807/100",
                shares: "9223372036854775807/100",
              }),
            ]),
          ],
        }),
      );
      const split = file.schedules[0].template?.splits[0];
      expect(split?.value).toBe("autoCalc");
      expect(split?.shares).toBe("autoCalc");
      expect(file.readerWarnings).toEqual([]);
    });

    it("clears the template post date when entrydate is a valid date", () => {
      const file = collect(
        kmyFile({
          accounts: [checking],
          schedules: [
            kmySchedule([templateSplit()], {}, { entrydate: "2024-01-01" }),
          ],
        }),
      );
      expect(file.schedules[0].template?.postDate).toBeNull();
    });

    it("refuses a template split on an unknown account", () => {
      expect(() =>
        collect(
          kmyFile({
            accounts: [checking],
            schedules: [kmySchedule([templateSplit({ account: "A404" })])],
          }),
        ),
      ).toThrow(KmyCorruptFileError);
    });

    it("counts matched-transaction pairs on template splits too", () => {
      const file = collect(
        kmyFile({
          accounts: [checking],
          schedules: [
            kmySchedule([
              kmySplitWith(
                { value: "1/1", shares: "1/1" },
                { kvp: { "kmm-matched-tx": "x" } },
              ),
            ]),
          ],
        }),
      );
      expect(file.counts.matchedTransactions).toBe(1);
    });
  });

  describe("securities, currencies, prices", () => {
    it("reads securities and applies the read defaults", () => {
      const file = collect(
        kmyFile({
          securities: [
            kmySecurity({}, { "kmm-security-id": "XS0000000000" }),
            kmySecurity({
              id: "E2",
              saf: 0,
              pp: 11,
              "rounding-method": undefined,
              "trading-currency": "",
              type: undefined,
            }),
            kmySecurity({ id: "E3", saf: undefined, pp: 0 }),
          ],
        }),
      );
      expect(file.securities[0]).toEqual({
        ordinal: 1,
        id: "E000001",
        name: "Example Corp",
        symbol: "EXC",
        type: 0,
        saf: 1000n,
        pp: 4,
        roundingMethod: 7,
        tradingCurrency: "USD",
        tradingMarket: "",
        kvp: new Map([["kmm-security-id", "XS0000000000"]]),
      });
      expect(file.securities[1]).toMatchObject({
        saf: 100n,
        pp: 4,
        roundingMethod: 0,
        tradingCurrency: null,
      });
      expect(file.securities[2]).toMatchObject({ saf: 100n, pp: 4 });
    });

    it("reads only SECURITY children of SECURITIES and CURRENCY of CURRENCIES", () => {
      const xml = kmyFile({
        securities: [
          kmySecurity(),
          kmyElement("EQUITY", { id: "E9" }),
          kmyCurrency({ id: "ZZZ" }),
        ],
        currencies: [kmyCurrency(), kmySecurity({ id: "E7" })],
      });
      const file = collect(xml);
      expect(file.securities.map((s) => s.id)).toEqual(["E000001"]);
      expect(file.currencies.map((c) => c.id)).toEqual(["USD"]);
    });

    it("reads currencies with their defaults", () => {
      const file = collect(
        kmyFile({
          currencies: [
            kmyCurrency({ id: "BTC", saf: 100000000, scf: 100000000, pp: 8 }),
            kmyCurrency({ id: "OLD", saf: 0, scf: undefined, pp: 0, ppu: "5" }),
          ],
        }),
      );
      expect(file.currencies[0]).toEqual({
        ordinal: 1,
        id: "BTC",
        name: "US Dollar",
        symbol: "$",
        saf: 100000000n,
        scf: 100000000n,
        pp: 8,
        roundingMethod: 7,
      });
      expect(file.currencies[1]).toMatchObject({ saf: 100n, scf: 100n, pp: 4 });
    });

    it("numbers prices across the whole section and skips a bad date", () => {
      const file = collect(
        kmyFile({
          prices: [
            kmyPricePair("E000001", "USD", [
              kmyPrice({ date: "2024-02-10", price: "50/1" }),
              kmyPrice({ date: "not-a-date" }),
            ]),
            kmyPricePair("EUR", "USD", [
              kmyPrice({ date: "2024-01-15", price: "11/10", source: "User" }),
              kmyPrice({ date: "2024-01-16", price: undefined }),
              kmyPrice({ date: "2024-01-17", price: "x" }),
            ]),
          ],
        }),
      );
      expect(file.prices).toEqual([
        {
          ordinal: 1,
          from: "E000001",
          to: "USD",
          date: "2024-02-10",
          price: rational(50n),
          source: "Transaction",
        },
        {
          ordinal: 3,
          from: "EUR",
          to: "USD",
          date: "2024-01-15",
          price: rational(11n, 10n),
          source: "User",
        },
        {
          ordinal: 4,
          from: "EUR",
          to: "USD",
          date: "2024-01-16",
          price: rational(0n),
          source: "Transaction",
        },
        {
          ordinal: 5,
          from: "EUR",
          to: "USD",
          date: "2024-01-17",
          price: rational(0n),
          source: "Transaction",
        },
      ]);
      expect(file.readerWarnings).toEqual([
        {
          code: "unparsableNumber",
          subject: "PRICE@price",
          transactionOrdinal: null,
        },
      ]);
    });
  });

  describe("elements that are counted or skipped", () => {
    it("counts reports, budgets and online jobs without reading their children", () => {
      const file = collect(
        kmyFile({
          standardAccounts: false,
          reports: [
            kmyElement("REPORT", { id: "R1" }, [
              kmyElement("ACCOUNT", { id: "A1" }),
              kmyElement("PAYEE", { id: "P1", name: "x" }),
              kmyElement("TAG", { id: "G1", name: "x" }),
            ]),
            kmyElement("REPORT", { id: "R2" }),
          ],
          budgets: [
            kmyElement("BUDGET", { id: "B1" }, [
              kmyElement("ACCOUNT", { id: "A1", budgetlevel: "monthly" }),
            ]),
          ],
          onlineJobs: [
            kmyElement("ONLINEJOB", { id: "O1" }),
            kmyElement("ONLINEJOB", { id: "O2" }),
            kmyElement("ONLINEJOB", { id: "O3" }),
          ],
        }),
      );
      expect(file.counts).toMatchObject({
        reports: 2,
        budgets: 1,
        onlineJobs: 3,
      });
      expect(file.accounts).toEqual([]);
      expect(file.payees).toEqual([]);
      expect(file.tags).toEqual([]);
    });

    it("skips unknown elements, a USER element and old count= attributes", () => {
      const xml = kmyFile({
        standardAccounts: false,
        tail: '<FUTURE a="1"><ACCOUNT id="X"/></FUTURE>',
      })
        .replace("<ACCOUNTS/>", '<ACCOUNTS count="1"/>')
        .replace("<PAYEES/>", '<PAYEES count="0"/>');
      const file = collect(xml);
      expect(file.accounts).toEqual([]);
    });

    it("accepts missing and self-closing sections in any order", () => {
      const xml =
        "<KMYMONEY-FILE><PRICES/><TRANSACTIONS/><ACCOUNTS/></KMYMONEY-FILE>";
      const file = collect(xml);
      expect(file.transactions).toEqual([]);
      expect(file.baseCurrency).toBeNull();
      expect(file.fileInfo.fixVersion).toBe(12);
    });
  });
});
