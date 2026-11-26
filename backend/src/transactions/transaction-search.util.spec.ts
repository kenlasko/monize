import { parseTransactionSearch } from "./transaction-search-query.util";
import { attachmentReachableFromTransactionSql } from "../attachments/attachment-parent";
import {
  buildTransactionSearchWhere,
  escapeLikePattern,
  hasAttachmentSql,
  hasWarrantySql,
  referenceKey,
  referenceKeySql,
  SearchClauseOptions,
  splitExistsSql,
  uncategorizedSql,
} from "./transaction-search.util";

describe("escapeLikePattern", () => {
  it("escapes backslash, percent, and underscore", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("returns plain text unchanged", () => {
    expect(escapeLikePattern("groceries")).toBe("groceries");
  });
});

describe("buildTransactionSearchWhere", () => {
  const EN = { numberFormat: "en-US", dateFormat: "YYYY-MM-DD" };
  const TX: SearchClauseOptions = {
    transaction: "transaction",
    grain: "transaction",
    paramPrefix: "srch",
  };
  const SPLIT: SearchClauseOptions = {
    transaction: "t",
    splits: "ts",
    grain: "split",
    paramPrefix: "srch",
  };

  function build(input: string, options: SearchClauseOptions = TX) {
    const clause = buildTransactionSearchWhere(
      parseTransactionSearch(input, EN).terms,
      options,
    );
    if (!clause) throw new Error(`no clause for ${input}`);
    return clause;
  }

  it("returns null for no terms and for only empty terms", () => {
    expect(buildTransactionSearchWhere([], TX)).toBeNull();
    expect(
      buildTransactionSearchWhere(
        parseTransactionSearch('ref: "" #""', EN).terms,
        TX,
      ),
    ).toBeNull();
  });

  it("ANDs one COALESCE-wrapped condition per term", () => {
    const { sql } = build("costco gas");
    expect(sql.startsWith("(COALESCE(")).toBe(true);
    expect(sql.split(") AND COALESCE(").length).toBe(2);
  });

  it("negates outside the COALESCE so a null column keeps the row", () => {
    const { sql } = build("-memo:rent");
    expect(sql).toMatch(/^\(NOT COALESCE\(/);
    expect(sql).toContain(", FALSE)");
  });

  it("skips an empty term but keeps the others", () => {
    const { sql, params } = build("ref: costco");
    expect(Object.values(params)).toEqual(["%costco%"]);
    expect(sql.split("COALESCE(").length - 1).toBe(1);
  });

  describe("bare terms keep today's arms", () => {
    it("binds the escaped contains pattern once and reuses it", () => {
      const { sql, params } = build("50%_off");
      expect(params).toEqual({ srch0: "%50\\%\\_off%" });
      for (const arm of [
        "transaction.description ILIKE :srch0",
        "transaction.payeeName ILIKE :srch0",
        "transaction.referenceNumber ILIKE :srch0",
        "CAST(transaction.amount AS TEXT) ILIKE :srch0",
        "search_sx.memo ILIKE :srch0",
        "CAST(search_sx.amount AS TEXT) ILIKE :srch0",
        "search_p.name ILIKE :srch0",
        "search_la.name ILIKE :srch0",
        "search_c.name ILIKE :srch0",
        "search_sc.name ILIKE :srch0",
        "search_tg.name ILIKE :srch0",
        "search_stg.name ILIKE :srch0",
      ]) {
        expect(sql).toContain(arm);
      }
      expect(sql).not.toContain("search_a.name");
    });

    it("adds the amount arms only when the term reads as an amount", () => {
      const { sql, params } = build("-12.34");
      expect(params.srch1).toBe(12.34);
      expect(sql).toContain(
        "ABS(transaction.amount) = CAST(:srch1 AS numeric)",
      );
      expect(sql).toContain("ABS(search_sx.amount) = CAST(:srch1 AS numeric)");
      expect(build("groceries").sql).not.toContain("ABS(");
    });

    it("adds the date arm only when the term reads as a date", () => {
      const { sql, params } = build("2026-03-15");
      expect(Object.values(params)).toContain("2026-03-15");
      expect(sql).toMatch(
        /transaction\.transactionDate = CAST\(:srch\d AS date\)/,
      );
      expect(build("groceries").sql).not.toContain("transactionDate");
    });
  });

  describe("grain", () => {
    it("correlates split arms to any split of the transaction", () => {
      expect(build("memo:rent").sql).toContain(
        "EXISTS (SELECT 1 FROM transaction_splits search_sx WHERE search_sx.transaction_id = transaction.id AND (search_sx.memo ILIKE :srch0))",
      );
    });

    it("correlates split arms to the row's own split at split grain", () => {
      expect(build("memo:rent", SPLIT).sql).toContain(
        "EXISTS (SELECT 1 FROM transaction_splits search_sx WHERE search_sx.id = ts.id AND (search_sx.memo ILIKE :srch0))",
      );
    });

    it("refuses a split grain without the split alias", () => {
      expect(() =>
        build("rent", { transaction: "t", grain: "split", paramPrefix: "p" }),
      ).toThrow();
    });
  });

  describe("text operators", () => {
    it("contains, exact and glob on a text field", () => {
      expect(build("payee:cost").params).toEqual({ srch0: "%cost%" });
      const exact = build('payee:=" Costco "');
      expect(exact.params).toEqual({ srch0: "Costco" });
      expect(exact.sql).toContain("btrim(transaction.payeeName) ILIKE :srch0");
      const glob = build("payee:*hydro_1*");
      expect(glob.params).toEqual({ srch0: "%hydro\\_1%" });
      expect(glob.sql).toContain("transaction.payeeName ILIKE :srch0");
    });

    it.each([
      ["payee:x", ["transaction.payeeName", "search_p.name", "search_la.name"]],
      ["memo:x", ["transaction.description", "search_sx.memo"]],
      ["cat:x", ["search_c.name", "search_sc.name"]],
      ["tag:x", ["search_tg.name", "search_stg.name"]],
      ["account:x", ["search_a.name"]],
      ["ref:x", ["transaction.referenceNumber"]],
    ])("%s reads only its own columns", (input, columns) => {
      const { sql } = build(input);
      const all = [
        "transaction.payeeName",
        "search_p.name",
        "search_la.name",
        "transaction.description",
        "search_sx.memo",
        "search_c.name",
        "search_sc.name",
        "search_tg.name",
        "search_stg.name",
        "search_a.name",
        "transaction.referenceNumber",
      ];
      for (const column of all) {
        expect(sql.includes(`${column} ILIKE`)).toBe(columns.includes(column));
      }
    });

    it("compares an exact reference through the reference key", () => {
      const { sql, params } = build("#0010");
      expect(params).toEqual({ srch0: "10" });
      expect(sql).toContain(
        `${referenceKeySql("transaction.referenceNumber")} = :srch0`,
      );
    });

    it("globs a reference on the raw column", () => {
      const { sql, params } = build("ref:10*");
      expect(params).toEqual({ srch0: "10%" });
      expect(sql).toContain("transaction.referenceNumber ILIKE :srch0");
    });
  });

  describe("enum fields", () => {
    it("binds the stored status value", () => {
      const { sql, params } = build("status:void");
      expect(params).toEqual({ srch0: "VOID" });
      expect(sql).toContain("transaction.status = :srch0");
    });

    it.each([
      ["is:transfer", "transaction.is_transfer = true"],
      ["is:split", "transaction.is_split = true"],
      ["is:provisional", "transaction.amount_is_provisional = true"],
      ["is:uncategorized", uncategorizedSql(TX)],
      ["has:attachment", hasAttachmentSql("transaction")],
      ["has:warranty", hasWarrantySql("transaction")],
      ["has:ref", "NULLIF(btrim(transaction.referenceNumber), '') IS NOT NULL"],
      ["has:memo", "NULLIF(btrim(search_sx.memo), '') IS NOT NULL"],
      [
        "has:tag",
        "transaction_split_tags search_stt WHERE search_stt.transaction_split_id = search_sx.id",
      ],
    ])("%s", (input, fragment) => {
      expect(build(input).sql).toContain(fragment);
    });

    // A transaction's attachments are its own rows plus the documents of
    // every warranty linked to it, archived or not (the maintainer's ruling,
    // attachment-parent.ts): `has:attachment` reaches both through the shared
    // fragment, primaries only.
    it("has:attachment is an EXISTS over the row's own and its linked warranties' visible attachments", () => {
      expect(hasAttachmentSql("t")).toBe(
        "EXISTS (SELECT 1 FROM transaction_attachments search_ta WHERE " +
          `${attachmentReachableFromTransactionSql("search_ta", "t.id")} ` +
          "AND search_ta.original_of_attachment_id IS NULL)",
      );
      expect(attachmentReachableFromTransactionSql("search_ta", "t.id")).toBe(
        "(search_ta.transaction_id = t.id OR search_ta.warranty_id IN " +
          "(SELECT reach_w.id FROM warranties reach_w WHERE reach_w.transaction_id = t.id))",
      );
      expect(build("has:attachment").params).toEqual({});
    });

    // A warranty is a second attachment parent: `has:warranty` reads the
    // warranties table, not the documents, and skips an archived warranty as
    // the register count does; `has:attachment` counts that warranty's
    // documents all the same.
    it("has:warranty is an EXISTS over the row's unarchived warranties", () => {
      expect(hasWarrantySql("t")).toBe(
        "EXISTS (SELECT 1 FROM warranties search_w WHERE search_w.transaction_id = t.id AND search_w.archived_at IS NULL)",
      );
      const { sql, params } = build("has:warranty");
      expect(sql).not.toContain("transaction_attachments");
      expect(params).toEqual({});
    });

    it("-has:warranty is the NOT EXISTS", () => {
      expect(build("-has:warranty").sql).toBe(
        `(NOT COALESCE(${hasWarrantySql("transaction")}, FALSE))`,
      );
    });
  });

  describe("amount and date", () => {
    it("amount equality reads the total and the split lines", () => {
      const { sql, params } = build("amount:20");
      expect(params).toEqual({ srch0: 20 });
      expect(sql).toContain(
        "ABS(transaction.amount) = CAST(:srch0 AS numeric)",
      );
      expect(sql).toContain("ABS(search_sx.amount) = CAST(:srch0 AS numeric)");
    });

    it.each([
      ["amount:>90", "ABS(transaction.amount) > CAST(:srch0 AS numeric)"],
      ["amount:<=90", "ABS(transaction.amount) <= CAST(:srch0 AS numeric)"],
      [
        "amount:50..100",
        "ABS(transaction.amount) BETWEEN CAST(:srch0 AS numeric) AND CAST(:srch1 AS numeric)",
      ],
      ["date:2026-03-15", "transaction.transactionDate = CAST(:srch0 AS date)"],
      [
        "date:2026-03",
        "transaction.transactionDate BETWEEN CAST(:srch0 AS date) AND CAST(:srch1 AS date)",
      ],
      ["date:>=2026-03", "transaction.transactionDate >= CAST(:srch0 AS date)"],
    ])("%s compares the total only", (input, fragment) => {
      const { sql } = build(input);
      expect(sql).toContain(fragment);
      expect(sql).not.toContain("search_sx");
    });
  });

  it("names parameters by prefix so two searches in one query never collide", () => {
    const a = build("costco amount:>5", { ...TX, paramPrefix: "a" });
    const b = build("costco amount:>5", { ...TX, paramPrefix: "b" });
    const names = [...Object.keys(a.params), ...Object.keys(b.params)];
    expect(new Set(names).size).toBe(names.length);
    expect(a.sql).not.toContain(":b");
  });
});

describe("referenceKey", () => {
  it.each([
    ["10", "10"],
    ["0010", "10"],
    ["#10", "10"],
    ["#0010", "10"],
    ["  10 ", "10"],
    ["A10", "a10"],
    ["a010", "a010"],
    ["0", "0"],
    ["000", "0"],
    ["#", ""],
    ["##10", "#10"],
  ])("%j -> %j", (input, key) => {
    expect(referenceKey(input)).toBe(key);
  });
});

describe("splitExistsSql", () => {
  it("is null with no conditions", () => {
    expect(
      splitExistsSql({ transaction: "t", grain: "transaction" }, []),
    ).toBeNull();
  });
});
