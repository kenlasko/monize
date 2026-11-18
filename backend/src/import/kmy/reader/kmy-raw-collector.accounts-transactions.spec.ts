import {
  kmyAccount,
  kmyFile,
  kmySplit,
  kmySplitWith,
  kmyTransaction,
  kmyTxId,
} from "../__fixtures__/kmy-xml-builders";
import { KmyCorruptFileError } from "../model/kmy-errors";
import { rational } from "../model/kmy-rational";
import { collect, checking, category } from "./kmy-raw-collector.test-helpers";

describe("KmyRawCollector", () => {
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
});
