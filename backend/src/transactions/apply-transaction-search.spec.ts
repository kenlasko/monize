import { EntityManager, SelectQueryBuilder } from "typeorm";

import { Transaction } from "./entities/transaction.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import {
  applyTransactionSearch,
  loadSearchFormats,
  resolveTransactionSearch,
  searchInterpretation,
} from "./apply-transaction-search";
import { parseTransactionSearch } from "./transaction-search-query.util";

function managerWith(
  prefs: Pick<UserPreference, "numberFormat" | "dateFormat"> | null,
) {
  const findOne = jest.fn<Promise<UserPreference | null>, [unknown]>(
    async () => prefs as UserPreference | null,
  );
  const m = {
    getRepository: jest.fn(() => ({ findOne })),
  } as unknown as EntityManager;
  return { m, findOne };
}

function queryBuilder() {
  const andWhere = jest.fn();
  const qb = { andWhere } as unknown as SelectQueryBuilder<Transaction>;
  qb.andWhere = andWhere.mockReturnValue(qb);
  return { qb, andWhere };
}

describe("loadSearchFormats", () => {
  it("reads the user's number and date formats", async () => {
    const { m, findOne } = managerWith({
      numberFormat: "de-DE",
      dateFormat: "DD.MM.YYYY",
    });
    await expect(loadSearchFormats(m, "user-1")).resolves.toEqual({
      numberFormat: "de-DE",
      dateFormat: "DD.MM.YYYY",
    });
    expect(findOne).toHaveBeenCalledWith({ where: { userId: "user-1" } });
  });

  it("falls back to the parser's defaults with no preference row", async () => {
    const { m } = managerWith(null);
    await expect(loadSearchFormats(m, "user-1")).resolves.toEqual({
      numberFormat: undefined,
      dateFormat: undefined,
    });
  });
});

describe("resolveTransactionSearch", () => {
  it.each([undefined, null, "", "   "])(
    "is undefined for %j without reading preferences",
    async (raw) => {
      const { m, findOne } = managerWith(null);
      await expect(
        resolveTransactionSearch(m, "u", raw),
      ).resolves.toBeUndefined();
      expect(findOne).not.toHaveBeenCalled();
    },
  );

  it("reads amounts in the user's number format", async () => {
    const de = managerWith({ numberFormat: "de-DE", dateFormat: "DD.MM.YYYY" });
    const parsed = await resolveTransactionSearch(de.m, "u", "amount:1.234,50");
    expect(parsed?.terms[0]).toMatchObject({ op: "eq", value: "1234.5" });

    const en = managerWith({ numberFormat: "en-US", dateFormat: "MM/DD/YYYY" });
    const enParsed = await resolveTransactionSearch(
      en.m,
      "u",
      "date:03/15/2026",
    );
    expect(enParsed?.terms[0]).toMatchObject({ op: "eq", value: "2026-03-15" });
  });
});

describe("applyTransactionSearch", () => {
  const options = {
    userId: "u",
    transaction: "transaction",
    grain: "transaction" as const,
    paramPrefix: "srch",
  };

  it("adds one condition and returns the parsed terms", async () => {
    const { m } = managerWith({
      numberFormat: "en-US",
      dateFormat: "YYYY-MM-DD",
    });
    const { qb, andWhere } = queryBuilder();
    const parsed = await applyTransactionSearch(m, qb, "#10 costco", options);
    expect(parsed?.terms).toHaveLength(2);
    expect(andWhere).toHaveBeenCalledTimes(1);
    const [sql, params] = andWhere.mock.calls[0];
    expect(sql).toContain(" AND ");
    expect(params).toMatchObject({ srch0: "10", srch1: "%costco%" });
  });

  it("adds nothing for a blank string", async () => {
    const { m } = managerWith(null);
    const { qb, andWhere } = queryBuilder();
    await expect(
      applyTransactionSearch(m, qb, "  ", options),
    ).resolves.toBeUndefined();
    expect(andWhere).not.toHaveBeenCalled();
  });

  it("adds nothing when every term is empty, but still returns them for the echo", async () => {
    const { m } = managerWith(null);
    const { qb, andWhere } = queryBuilder();
    const parsed = await applyTransactionSearch(m, qb, "ref:", options);
    expect(parsed?.terms[0].ignored).toBe("empty");
    expect(andWhere).not.toHaveBeenCalled();
  });

  it.each([
    [
      "is:provisional",
      "COALESCE(transaction.amount_is_provisional = true, FALSE)",
    ],
    [
      "-is:provisional",
      "NOT COALESCE(transaction.amount_is_provisional = true, FALSE)",
    ],
  ])("%s filters on the provisional column", async (input, fragment) => {
    const { m } = managerWith(null);
    const { qb, andWhere } = queryBuilder();
    await applyTransactionSearch(m, qb, input, options);
    expect(andWhere).toHaveBeenCalledTimes(1);
    expect(andWhere.mock.calls[0][0]).toContain(fragment);
    expect(andWhere.mock.calls[0][0]).not.toContain("PENDING IMPORT");
  });
});

describe("searchInterpretation", () => {
  it("echoes every term as read, without the builder-internal reading", () => {
    const parsed = parseTransactionSearch(
      "costco -cat:gas #10 date:2026-03 amount:>abc ref:",
      { numberFormat: "en-US", dateFormat: "YYYY-MM-DD" },
    );
    expect(searchInterpretation(parsed)).toEqual({
      terms: [
        {
          field: "any",
          op: "contains",
          value: "costco",
          negated: false,
          raw: "costco",
        },
        {
          field: "cat",
          op: "contains",
          value: "gas",
          negated: true,
          raw: "-cat:gas",
        },
        { field: "ref", op: "exact", value: "10", negated: false, raw: "#10" },
        {
          field: "date",
          op: "between",
          value: "2026-03-01",
          valueTo: "2026-03-31",
          negated: false,
          raw: "date:2026-03",
        },
        {
          field: "any",
          op: "contains",
          value: "amount:>abc",
          negated: false,
          raw: "amount:>abc",
          ignored: "malformed",
        },
        {
          field: "ref",
          op: "contains",
          value: "",
          negated: false,
          raw: "ref:",
          ignored: "empty",
        },
      ],
    });
  });

  it("echoes has:warranty as a recognised value, and a misspelling as ignored", () => {
    const parsed = parseTransactionSearch("has:warranty -has:warranties", {
      numberFormat: "en-US",
      dateFormat: "YYYY-MM-DD",
    });
    expect(searchInterpretation(parsed).terms).toEqual([
      {
        field: "has",
        op: "eq",
        value: "warranty",
        negated: false,
        raw: "has:warranty",
      },
      expect.objectContaining({
        raw: "-has:warranties",
        ignored: "malformed",
      }),
    ]);
  });

  it("echoes is:provisional and its negation like is:transfer", () => {
    const parsed = parseTransactionSearch("is:provisional -is:provisional", {
      numberFormat: "en-US",
      dateFormat: "YYYY-MM-DD",
    });
    expect(searchInterpretation(parsed).terms).toEqual([
      {
        field: "is",
        op: "eq",
        value: "provisional",
        negated: false,
        raw: "is:provisional",
      },
      {
        field: "is",
        op: "eq",
        value: "provisional",
        negated: true,
        raw: "-is:provisional",
      },
    ]);
  });
});
