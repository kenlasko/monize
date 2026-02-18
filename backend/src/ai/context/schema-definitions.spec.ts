import { CATEGORIZATION_TOOL, QUERY_TRANSACTIONS_TOOL } from "./schema-definitions";

describe("schema-definitions", () => {
  describe("CATEGORIZATION_TOOL", () => {
    it("has the expected name", () => {
      expect(CATEGORIZATION_TOOL.name).toBe("categorize_transaction");
    });

    it("has a description", () => {
      expect(typeof CATEGORIZATION_TOOL.description).toBe("string");
      expect(CATEGORIZATION_TOOL.description.length).toBeGreaterThan(0);
    });

    it("has an inputSchema object", () => {
      expect(typeof CATEGORIZATION_TOOL.inputSchema).toBe("object");
    });

    it("is currently a placeholder", () => {
      expect(CATEGORIZATION_TOOL.description).toContain("TODO");
    });
  });

  describe("QUERY_TRANSACTIONS_TOOL", () => {
    it("has the expected name", () => {
      expect(QUERY_TRANSACTIONS_TOOL.name).toBe("query_transactions");
    });

    it("has a description", () => {
      expect(typeof QUERY_TRANSACTIONS_TOOL.description).toBe("string");
      expect(QUERY_TRANSACTIONS_TOOL.description.length).toBeGreaterThan(0);
    });

    it("has an inputSchema object", () => {
      expect(typeof QUERY_TRANSACTIONS_TOOL.inputSchema).toBe("object");
    });

    it("is currently a placeholder", () => {
      expect(QUERY_TRANSACTIONS_TOOL.description).toContain("TODO");
    });
  });

  it("both tools conform to AiToolDefinition shape", () => {
    for (const tool of [CATEGORIZATION_TOOL, QUERY_TRANSACTIONS_TOOL]) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("inputSchema");
    }
  });
});
