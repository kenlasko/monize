import { EntityManager } from "typeorm";
import {
  loadQualifiedCategoryNames,
  CATEGORY_PATH_SEPARATOR,
  canonicalCategoryPath,
  qualifiedCategoryName,
  qualifiedNamesById,
  resolveCategoryNamePaths,
} from "./category-name.util";

/**
 * A chart of accounts with the shape that broke this: the same leaf name under
 * two different parents. It is not exotic -- "Cell Phone" as a household bill
 * and as a business expense is how anyone with a side business files it.
 */
const TREE = [
  { id: "bills", name: "Bills", parentId: null },
  { id: "bills-cell", name: "Cell Phone", parentId: "bills" },
  { id: "bills-hydro", name: "Hydro", parentId: "bills" },
  { id: "biz", name: "Business", parentId: null },
  { id: "biz-cell", name: "Cell Phone", parentId: "biz" },
  { id: "food", name: "Food", parentId: null },
  { id: "dining", name: "Dining Out", parentId: "food" },
  { id: "groceries", name: "Groceries", parentId: null },
];

const resolveOne = (input: string, tree = TREE) =>
  resolveCategoryNamePaths(tree, [input])[0];

describe("qualifiedCategoryName", () => {
  it("prefixes the parent for a subcategory", () => {
    expect(qualifiedCategoryName("Cell Phone", "Business")).toBe(
      "Business: Cell Phone",
    );
  });

  it("leaves a top-level category unqualified", () => {
    expect(qualifiedCategoryName("Groceries", null)).toBe("Groceries");
    expect(qualifiedCategoryName("Groceries")).toBe("Groceries");
  });

  it("uses the separator the tool descriptions tell the model to type", () => {
    expect(CATEGORY_PATH_SEPARATOR).toBe(": ");
  });
});

describe("qualifiedNamesById", () => {
  it("maps every category to its display name", () => {
    const names = qualifiedNamesById(TREE);
    expect(names.get("biz-cell")).toBe("Business: Cell Phone");
    expect(names.get("bills-cell")).toBe("Bills: Cell Phone");
    expect(names.get("groceries")).toBe("Groceries");
  });

  it("falls back to the bare name when the parent is not in the set", () => {
    const orphan = [{ id: "x", name: "Orphan", parentId: "missing" }];
    expect(qualifiedNamesById(orphan).get("x")).toBe("Orphan");
  });
});

describe("resolveCategoryNamePaths", () => {
  describe("the reported failure", () => {
    it('resolves "Business: Cell Phone" to the Business child', () => {
      // The exact spelling the tool descriptions and error messages ask for.
      // It used to miss the qualified lookup and fall through to a last-segment
      // match, which returned Bills: Cell Phone -- data about a category the
      // user never asked about, labelled as if it were theirs.
      expect(resolveOne("Business: Cell Phone").id).toBe("biz-cell");
    });

    it("does not answer with the other parent's category", () => {
      expect(resolveOne("Business: Cell Phone").id).not.toBe("bills-cell");
      expect(resolveOne("Bills: Cell Phone").id).toBe("bills-cell");
    });
  });

  describe("spelling and separators", () => {
    const spellings = [
      "Business: Cell Phone",
      "Business:Cell Phone",
      "Business : Cell Phone",
      "business:cell phone",
      "  Business  :   Cell   Phone  ",
      "Business/Cell Phone",
      "Business / Cell Phone",
      "Business > Cell Phone",
      "Business -> Cell Phone",
      "Business>Cell Phone",
    ];

    it.each(spellings)("resolves %s", (input) => {
      expect(resolveOne(input).id).toBe("biz-cell");
    });

    it("canonicalizes every separator to one key", () => {
      const keys = new Set(spellings.map(canonicalCategoryPath));
      expect(keys).toEqual(new Set(["business:cell phone"]));
    });
  });

  describe("bare names", () => {
    it("resolves a unique leaf", () => {
      expect(resolveOne("Dining Out").id).toBe("dining");
      expect(resolveOne("groceries").id).toBe("groceries");
    });

    it("resolves a top-level category", () => {
      expect(resolveOne("Bills").id).toBe("bills");
    });

    it("refuses an ambiguous leaf and says what it could have meant", () => {
      // Silently picking one is the defect. The model can re-ask with a
      // qualified name; it cannot recover from a confident wrong answer.
      const result = resolveOne("Cell Phone");
      expect(result.id).toBeNull();
      expect(result.failure).toBe("ambiguous");
      expect(result.candidates.sort()).toEqual([
        "Bills: Cell Phone",
        "Business: Cell Phone",
      ]);
    });
  });

  describe("a wrong parent", () => {
    it("still resolves when the leaf is unique", () => {
      // "Food: Groceries" names a real category under the wrong parent.
      expect(resolveOne("Food: Groceries").id).toBe("groceries");
    });

    it("refuses when the leaf is ambiguous", () => {
      const result = resolveOne("Utilities: Cell Phone");
      expect(result.id).toBeNull();
      expect(result.failure).toBe("ambiguous");
      expect(result.candidates).toHaveLength(2);
    });
  });

  describe("unknown names", () => {
    it("reports them as unknown with no candidates", () => {
      const result = resolveOne("Yacht Maintenance");
      expect(result.id).toBeNull();
      expect(result.failure).toBe("unknown");
      expect(result.candidates).toEqual([]);
    });
  });

  describe("a category whose own name contains a separator", () => {
    const withColon = [
      { id: "inv", name: "Investments", parentId: null },
      { id: "ike", name: "IKE", parentId: "inv" },
      { id: "literal", name: "Investments: IKE", parentId: null },
    ];

    it("prefers the category actually named that", () => {
      expect(resolveOne("Investments: IKE", withColon).id).toBe("literal");
    });

    it("reaches the child by its own unique name", () => {
      expect(resolveOne("IKE", withColon).id).toBe("ike");
    });

    it("refuses a path that could be either reading", () => {
      // "Investments > IKE" canonicalizes onto the same key as the category
      // literally named "Investments: IKE". Two real answers, so neither is
      // returned -- the candidates say what to ask for instead.
      const result = resolveOne("Investments > IKE", withColon);
      expect(result.id).toBeNull();
      expect(result.failure).toBe("ambiguous");
      // Both candidates display as "Investments: IKE" -- one is a top-level
      // category named that literally, the other is IKE under Investments.
      // Two categories a user cannot tell apart on screen either; refusing is
      // the only answer that does not quietly pick one.
      expect(result.candidates).toEqual([
        "Investments: IKE",
        "Investments: IKE",
      ]);
    });
  });

  it("resolves each input independently", () => {
    const results = resolveCategoryNamePaths(TREE, [
      "Business: Cell Phone",
      "Cell Phone",
      "Nope",
    ]);
    expect(results.map((r) => r.id)).toEqual(["biz-cell", null, null]);
    expect(results.map((r) => r.failure)).toEqual([
      undefined,
      "ambiguous",
      "unknown",
    ]);
  });

  it("returns nothing for no inputs", () => {
    expect(resolveCategoryNamePaths(TREE, [])).toEqual([]);
  });
});

describe("the round trip", () => {
  /**
   * The invariant the pair exists for, and the one the old code broke: a name
   * we hand the model has to come back as the category we handed it for. Every
   * emitted label is fed straight back into the resolver here, so a change to
   * either half that breaks the other fails this test rather than surfacing as
   * an answer about the wrong category.
   */
  it("resolves every emitted name back to its own category", () => {
    const names = qualifiedNamesById(TREE);
    for (const category of TREE) {
      const emitted = names.get(category.id) as string;
      expect(resolveOne(emitted).id).toBe(category.id);
    }
  });

  it("holds for names that differ only by parent", () => {
    const names = qualifiedNamesById(TREE);
    expect(resolveOne(names.get("bills-cell") as string).id).toBe("bills-cell");
    expect(resolveOne(names.get("biz-cell") as string).id).toBe("biz-cell");
  });
});

describe("loadQualifiedCategoryNames", () => {
  const rows = [
    { id: "t", name: "Transfers", parentId: null, categoryType: "transfer" },
    { id: "t-save", name: "Savings", parentId: "t", categoryType: "transfer" },
    { id: "food", name: "Food", parentId: null, categoryType: "expense" },
  ];
  const manager = {
    getRepository: () => ({ find: jest.fn().mockResolvedValue(rows) }),
  } as unknown as EntityManager;

  it("names every category, and only Income and Expense ones for a category line (INV-CATEGORY-001)", async () => {
    expect(
      [...(await loadQualifiedCategoryNames(manager, "u")).values()].sort(),
    ).toEqual(["Food", "Transfers", "Transfers: Savings"]);
    expect([
      ...(
        await loadQualifiedCategoryNames(manager, "u", { holder: "category" })
      ).values(),
    ]).toEqual(["Food"]);
  });
});
