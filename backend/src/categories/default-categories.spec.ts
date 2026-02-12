import {
  DEFAULT_INCOME_CATEGORIES,
  DEFAULT_EXPENSE_CATEGORIES,
  DefaultCategoryDefinition,
} from "./default-categories";

describe("default-categories", () => {
  describe("DEFAULT_INCOME_CATEGORIES", () => {
    it("should be a non-empty array", () => {
      expect(Array.isArray(DEFAULT_INCOME_CATEGORIES)).toBe(true);
      expect(DEFAULT_INCOME_CATEGORIES.length).toBeGreaterThan(0);
    });

    it("should have correct structure for each category", () => {
      for (const category of DEFAULT_INCOME_CATEGORIES) {
        expect(typeof category.name).toBe("string");
        expect(category.name.length).toBeGreaterThan(0);
        expect(Array.isArray(category.subcategories)).toBe(true);
      }
    });

    it("should contain Investment Income category", () => {
      const found = DEFAULT_INCOME_CATEGORIES.find(
        (c) => c.name === "Investment Income",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Capital Gains");
      expect(found!.subcategories).toContain("Interest");
    });

    it("should contain Wages & Salary category", () => {
      const found = DEFAULT_INCOME_CATEGORIES.find(
        (c) => c.name === "Wages & Salary",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Gross Pay");
      expect(found!.subcategories).toContain("Net Pay");
      expect(found!.subcategories).toContain("Bonus");
    });

    it("should contain Other Income category", () => {
      const found = DEFAULT_INCOME_CATEGORIES.find(
        (c) => c.name === "Other Income",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Cashback");
      expect(found!.subcategories).toContain("Gifts Received");
    });

    it("should contain Retirement Income category", () => {
      const found = DEFAULT_INCOME_CATEGORIES.find(
        (c) => c.name === "Retirement Income",
      );
      expect(found).toBeDefined();
    });

    it("should have unique category names", () => {
      const names = DEFAULT_INCOME_CATEGORIES.map((c) => c.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it("should have unique subcategory names within each category", () => {
      for (const category of DEFAULT_INCOME_CATEGORIES) {
        const uniqueSubs = new Set(category.subcategories);
        expect(uniqueSubs.size).toBe(category.subcategories.length);
      }
    });
  });

  describe("DEFAULT_EXPENSE_CATEGORIES", () => {
    it("should be a non-empty array", () => {
      expect(Array.isArray(DEFAULT_EXPENSE_CATEGORIES)).toBe(true);
      expect(DEFAULT_EXPENSE_CATEGORIES.length).toBeGreaterThan(0);
    });

    it("should have correct structure for each category", () => {
      for (const category of DEFAULT_EXPENSE_CATEGORIES) {
        expect(typeof category.name).toBe("string");
        expect(category.name.length).toBeGreaterThan(0);
        expect(Array.isArray(category.subcategories)).toBe(true);
      }
    });

    it("should contain Automobile category", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Automobile",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Gasoline");
      expect(found!.subcategories).toContain("Maintenance");
      expect(found!.subcategories).toContain("Parking");
    });

    it("should contain Food category", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Food",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Groceries");
      expect(found!.subcategories).toContain("Dining Out");
    });

    it("should contain Housing category", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Housing",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Rent");
      expect(found!.subcategories).toContain("Mortgage Interest");
      expect(found!.subcategories).toContain("Mortgage Principal");
    });

    it("should contain Healthcare category", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Healthcare",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Dental");
      expect(found!.subcategories).toContain("Medication");
      expect(found!.subcategories).toContain("Physician");
    });

    it("should contain Insurance category", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Insurance",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Automobile");
      expect(found!.subcategories).toContain("Health");
      expect(found!.subcategories).toContain("Life");
    });

    it("should contain Taxes category", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Taxes",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Federal Income");
      expect(found!.subcategories).toContain("Property");
    });

    it("should contain Bills category", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Bills",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Electricity");
      expect(found!.subcategories).toContain("Internet");
      expect(found!.subcategories).toContain("Cell Phone");
    });

    it("should contain Loan category", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Loan",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Loan Interest");
      expect(found!.subcategories).toContain("Loan Principal");
    });

    it("should contain Vacation category", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Vacation",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toContain("Airfare");
      expect(found!.subcategories).toContain("Lodging");
    });

    it("should contain Charitable Donations category", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Charitable Donations",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toEqual([]);
    });

    it("should contain Interest Expense category with no subcategories", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Interest Expense",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toEqual([]);
    });

    it("should contain Licencing Fees category with no subcategories", () => {
      const found = DEFAULT_EXPENSE_CATEGORIES.find(
        (c) => c.name === "Licencing Fees",
      );
      expect(found).toBeDefined();
      expect(found!.subcategories).toEqual([]);
    });

    it("should have unique category names", () => {
      const names = DEFAULT_EXPENSE_CATEGORIES.map((c) => c.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });

    it("should have unique subcategory names within each category", () => {
      for (const category of DEFAULT_EXPENSE_CATEGORIES) {
        const uniqueSubs = new Set(category.subcategories);
        expect(uniqueSubs.size).toBe(category.subcategories.length);
      }
    });

    it("should contain expected number of expense categories", () => {
      // There are 25 expense categories based on the source file
      expect(DEFAULT_EXPENSE_CATEGORIES.length).toBe(25);
    });
  });

  describe("combined validation", () => {
    it("should have no overlapping category names between income and expense", () => {
      const incomeNames = new Set(
        DEFAULT_INCOME_CATEGORIES.map((c) => c.name),
      );
      const expenseNames = DEFAULT_EXPENSE_CATEGORIES.map((c) => c.name);

      for (const name of expenseNames) {
        expect(incomeNames.has(name)).toBe(false);
      }
    });

    it("should have all category names be non-empty strings", () => {
      const allCategories = [
        ...DEFAULT_INCOME_CATEGORIES,
        ...DEFAULT_EXPENSE_CATEGORIES,
      ];
      for (const category of allCategories) {
        expect(category.name.trim()).not.toBe("");
      }
    });

    it("should have all subcategory names be non-empty strings", () => {
      const allCategories = [
        ...DEFAULT_INCOME_CATEGORIES,
        ...DEFAULT_EXPENSE_CATEGORIES,
      ];
      for (const category of allCategories) {
        for (const sub of category.subcategories) {
          expect(typeof sub).toBe("string");
          expect(sub.trim()).not.toBe("");
        }
      }
    });

    it("should export DefaultCategoryDefinition interface-compatible objects", () => {
      // Type check: each entry should satisfy the interface
      const typeCheck = (cat: DefaultCategoryDefinition): boolean => {
        return (
          typeof cat.name === "string" && Array.isArray(cat.subcategories)
        );
      };

      for (const cat of DEFAULT_INCOME_CATEGORIES) {
        expect(typeCheck(cat)).toBe(true);
      }
      for (const cat of DEFAULT_EXPENSE_CATEGORIES) {
        expect(typeCheck(cat)).toBe(true);
      }
    });

    it("should contain expected number of income categories", () => {
      // There are 4 income categories based on the source file
      expect(DEFAULT_INCOME_CATEGORIES.length).toBe(4);
    });

    it("should have subcategories as string arrays (not objects or numbers)", () => {
      const allCategories = [
        ...DEFAULT_INCOME_CATEGORIES,
        ...DEFAULT_EXPENSE_CATEGORIES,
      ];
      for (const category of allCategories) {
        for (const sub of category.subcategories) {
          expect(typeof sub).toBe("string");
        }
      }
    });
  });
});
