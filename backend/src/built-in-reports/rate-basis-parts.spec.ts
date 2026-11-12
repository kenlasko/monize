import { SelectQueryBuilder } from "typeorm";
import {
  convertRateParts,
  foldRateParts,
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
