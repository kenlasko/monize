import {
  buildTagKeyFilterClause,
  tagKeyOpNeedsValue,
} from "./tag-key-filter.util";

describe("buildTagKeyFilterClause", () => {
  it("binds the key (never interpolates) and matches transaction + split tags", () => {
    const { clause, params } = buildTagKeyFilterClause("t", {
      key: "country",
      op: "hasValue",
    });

    expect(params).toEqual({ tkfKey: "country" });
    // Key is bound, not inlined.
    expect(clause).not.toContain("country");
    expect(clause).toContain(":tkfKey");
    // Matches either the transaction's own tags or any split's tags.
    expect(clause).toContain("transaction_tags");
    expect(clause).toContain("transaction_split_tags");
    expect(clause).toContain("t.id");
    // hasValue is not negated and requires a non-empty value.
    expect(clause.startsWith("NOT")).toBe(false);
    expect(clause).toContain("<> ''");
  });

  it("negates for noValue", () => {
    const { clause } = buildTagKeyFilterClause("t", {
      key: "country",
      op: "noValue",
    });
    expect(clause.startsWith("NOT ")).toBe(true);
    expect(clause).toContain("<> ''");
  });

  it("binds an escaped LIKE term for contains", () => {
    const { clause, params } = buildTagKeyFilterClause("t", {
      key: "country",
      op: "contains",
      value: "us_a%",
    });
    // Wildcards in the term are escaped; wrapped in %...%.
    expect(params.tkfVal).toBe("%us\\_a\\%%");
    expect(clause).toContain("LIKE LOWER(:tkfVal)");
    expect(clause.startsWith("NOT")).toBe(false);
  });

  it("negates and binds the term for notContains", () => {
    const { clause, params } = buildTagKeyFilterClause("t", {
      key: "country",
      op: "notContains",
      value: "usa",
    });
    expect(clause.startsWith("NOT ")).toBe(true);
    expect(params.tkfVal).toBe("%usa%");
  });

  it("honours a custom param prefix", () => {
    const { clause, params } = buildTagKeyFilterClause(
      "bf",
      { key: "sector", op: "hasValue" },
      "sec",
    );
    expect(params).toEqual({ secKey: "sector" });
    expect(clause).toContain(":secKey");
    expect(clause).toContain("bf.id");
  });

  it("tagKeyOpNeedsValue reflects which ops take a term", () => {
    expect(tagKeyOpNeedsValue("contains")).toBe(true);
    expect(tagKeyOpNeedsValue("notContains")).toBe(true);
    expect(tagKeyOpNeedsValue("hasValue")).toBe(false);
    expect(tagKeyOpNeedsValue("noValue")).toBe(false);
  });
});
