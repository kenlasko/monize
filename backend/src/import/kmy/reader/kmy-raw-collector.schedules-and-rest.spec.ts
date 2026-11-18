import {
  kmyCurrency,
  kmyElement,
  kmyFile,
  kmyPrice,
  kmyPricePair,
  kmySchedule,
  kmySecurity,
  kmySplit,
  kmySplitWith,
} from "../__fixtures__/kmy-xml-builders";
import { KmyCorruptFileError } from "../model/kmy-errors";
import { rational } from "../model/kmy-rational";
import { collect, checking } from "./kmy-raw-collector.test-helpers";

describe("KmyRawCollector", () => {
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
