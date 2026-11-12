import { SelectQueryBuilder } from "typeorm";
import {
  convertRateParts,
  foldRateParts,
  partRateBasis,
  readTopGroupParts,
  splitByRateBasis,
} from "./rate-basis-parts";

describe("rate-basis-parts", () => {
  describe("splitByRateBasis", () => {
    it("keys a foreign row by its day and own rate, and binds the currency", () => {
      const qb = {
        setParameter: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
      };

      splitByRateBasis(
        qb as unknown as SelectQueryBuilder<object>,
        {
          currency: "t.currency_code",
          date: "t.transaction_date",
          originalCurrency: "t.original_currency_code",
          exchangeRate: "t.exchange_rate",
        },
        "CAD",
      );

      expect(qb.setParameter).toHaveBeenCalledWith(
        "fxReportingCurrency",
        "CAD",
      );
      expect(qb.addSelect.mock.calls).toEqual([
        [
          "CASE WHEN t.currency_code <> :fxReportingCurrency THEN TO_CHAR(t.transaction_date, 'YYYY-MM-DD') END",
          "fx_day",
        ],
        [
          "CASE WHEN t.currency_code <> :fxReportingCurrency THEN t.original_currency_code END",
          "fx_original_currency",
        ],
        [
          "CASE WHEN t.currency_code <> :fxReportingCurrency THEN t.exchange_rate END",
          "fx_exchange_rate",
        ],
      ]);
      expect(qb.addGroupBy.mock.calls.map((c) => c[0])).toEqual([
        "fx_day",
        "fx_original_currency",
        "fx_exchange_rate",
      ]);
    });
  });

  describe("splitByRateBasis without the day", () => {
    it("adds only the own-rate columns", () => {
      const qb = {
        setParameter: jest.fn().mockReturnThis(),
        addSelect: jest.fn().mockReturnThis(),
        addGroupBy: jest.fn().mockReturnThis(),
      };

      splitByRateBasis(
        qb as unknown as SelectQueryBuilder<object>,
        {
          currency: "t.currencyCode",
          originalCurrency: "t.originalCurrencyCode",
          exchangeRate: "t.exchangeRate",
        },
        "CAD",
        { byDay: false },
      );

      expect(qb.addGroupBy.mock.calls.map((c) => c[0])).toEqual([
        "fx_original_currency",
        "fx_exchange_rate",
      ]);
    });
  });

  describe("partRateBasis", () => {
    it("reads a part's own rate into the reporting currency, and none for a stored 1", () => {
      expect(
        partRateBasis(
          { fx_original_currency: "CAD", fx_exchange_rate: "0.8" },
          "USD",
          "2026-01-12",
          "CAD",
        ),
      ).toEqual({ currency_code: "USD", tx_date: "2026-01-12", own_rate: 0.8 });
      expect(
        partRateBasis(
          { fx_original_currency: "CAD", fx_exchange_rate: "1" },
          "USD",
          "2026-01-12",
          "CAD",
        ).own_rate,
      ).toBeNull();
      expect(partRateBasis({}, "CAD", null, "CAD").tx_date).toBeNull();
    });
  });

  describe("readTopGroupParts", () => {
    it("bounds the groups in SQL, ranked by their parts' magnitude then key", async () => {
      const qb = {
        addSelect: jest.fn().mockReturnThis(),
        getQueryAndParameters: jest
          .fn()
          .mockReturnValue(["SELECT inner WHERE a = $1", ["user-1"]]),
      };
      const m = { query: jest.fn().mockResolvedValue([{ group_key: "k" }]) };

      const parts = await readTopGroupParts(
        m as never,
        qb as unknown as SelectQueryBuilder<object>,
        "CONCAT(a, b)",
        "magnitude",
        100,
      );

      expect(parts).toEqual([{ group_key: "k" }]);
      expect(qb.addSelect).toHaveBeenCalledWith("CONCAT(a, b)", "group_key");
      const [sql, params] = m.query.mock.calls[0];
      expect(sql).toContain("WITH parts AS (SELECT inner WHERE a = $1)");
      expect(sql).toContain('ORDER BY SUM(parts."magnitude") DESC, group_key');
      expect(sql).toContain("LIMIT $2");
      expect(params).toEqual(["user-1", 100]);
    });
  });

  describe("foldRateParts", () => {
    it("sums each figure exactly, adds the counts and keeps the latest date", () => {
      const folded = foldRateParts(
        [
          { key: "a", total: "0.1", count: "1", last: "2026-01-02" },
          { key: "b", total: "5", count: "2", last: null },
          { key: "a", total: "0.2", count: "3", last: "2026-03-04" },
          { key: "a", total: "0.00000001", count: "1", last: "2026-02-01" },
        ],
        (row) => row.key,
        { sums: ["total"], count: "count", latest: "last" },
      );

      expect(folded).toEqual([
        {
          key: "a",
          first: expect.objectContaining({ total: "0.1" }),
          sums: { total: 0.30000001 },
          count: 5,
          latest: "2026-03-04",
        },
        {
          key: "b",
          first: expect.objectContaining({ total: "5" }),
          sums: { total: 5 },
          count: 2,
          latest: null,
        },
      ]);
    });
  });

  describe("convertRateParts", () => {
    it("converts only the foreign parts, at their own rate or their date's", async () => {
      const query = jest.fn().mockResolvedValue([
        {
          from_currency: "CAD",
          to_currency: "USD",
          rate: "0.8",
          rate_date: "2026-01-10",
        },
      ]);

      const converted = await convertRateParts(
        query,
        [
          { key: "a", currencyCode: "CAD", fx_day: null, total: "10" },
          {
            key: "a",
            currencyCode: "USD",
            fx_day: "2026-01-12",
            fx_original_currency: null,
            fx_exchange_rate: "1",
            total: "100",
          },
          {
            key: "a",
            currencyCode: "USD",
            fx_day: "2026-01-12",
            fx_original_currency: "CAD",
            fx_exchange_rate: "0.7692307692",
            total: "100",
          },
        ],
        "CAD",
        (row) => `${row.key}|${row.currencyCode}`,
        { sums: ["total"], currency: "currencyCode" },
      );

      // 100 USD at 1.25 plus 100 USD at its own 1.30; the CAD part is not
      // the conversion's to answer.
      expect([...converted.entries()]).toEqual([["a|USD", { total: 255 }]]);
    });
  });
});
