import {
  CATEGORIZATION_SYSTEM_PROMPT,
  QUERY_SYSTEM_PROMPT,
  INSIGHT_SYSTEM_PROMPT,
  FORECAST_SYSTEM_PROMPT,
} from "./prompt-templates";

describe("prompt-templates", () => {
  describe("QUERY_SYSTEM_PROMPT", () => {
    it("is a non-empty string", () => {
      expect(typeof QUERY_SYSTEM_PROMPT).toBe("string");
      expect(QUERY_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it("is not a TODO placeholder", () => {
      expect(QUERY_SYSTEM_PROMPT).not.toMatch(/^TODO/);
    });

    it("instructs the AI to use tools for real data", () => {
      expect(QUERY_SYSTEM_PROMPT).toMatch(/use.*tools/i);
      expect(QUERY_SYSTEM_PROMPT).toMatch(/never guess|never make up/i);
    });

    it("instructs the AI to calculate date ranges", () => {
      expect(QUERY_SYSTEM_PROMPT).toMatch(/YYYY-MM-DD/);
      expect(QUERY_SYSTEM_PROMPT).toMatch(/date range/i);
    });

    it("instructs the AI to present amounts with currency formatting", () => {
      expect(QUERY_SYSTEM_PROMPT).toMatch(/currency/i);
      expect(QUERY_SYSTEM_PROMPT).toMatch(/\$[\d,]+\.\d{2}/);
    });

    it("forbids revealing individual transaction details", () => {
      expect(QUERY_SYSTEM_PROMPT).toMatch(
        /never reveal individual transaction/i,
      );
    });

    it("instructs the AI to show expenses as positive numbers", () => {
      expect(QUERY_SYSTEM_PROMPT).toMatch(
        /positive.*numbers|positive.*amounts/i,
      );
    });

    it("instructs the AI to ask clarifying questions when unsure", () => {
      expect(QUERY_SYSTEM_PROMPT).toMatch(/clarif/i);
    });

    it("mentions chart suggestions", () => {
      expect(QUERY_SYSTEM_PROMPT).toMatch(/chart/i);
    });

    it("explains the sign convention for amounts", () => {
      expect(QUERY_SYSTEM_PROMPT).toMatch(/positive.*income/i);
      expect(QUERY_SYSTEM_PROMPT).toMatch(/negative.*expense/i);
    });
  });

  describe("placeholder prompts", () => {
    it("CATEGORIZATION_SYSTEM_PROMPT is a placeholder", () => {
      expect(CATEGORIZATION_SYSTEM_PROMPT).toContain("TODO");
    });

    it("INSIGHT_SYSTEM_PROMPT is a placeholder", () => {
      expect(INSIGHT_SYSTEM_PROMPT).toContain("TODO");
    });

    it("FORECAST_SYSTEM_PROMPT is a placeholder", () => {
      expect(FORECAST_SYSTEM_PROMPT).toContain("TODO");
    });
  });
});
