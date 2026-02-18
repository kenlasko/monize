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

  describe("INSIGHT_SYSTEM_PROMPT", () => {
    it("is a non-empty string", () => {
      expect(typeof INSIGHT_SYSTEM_PROMPT).toBe("string");
      expect(INSIGHT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it("is not a TODO placeholder", () => {
      expect(INSIGHT_SYSTEM_PROMPT).not.toMatch(/^TODO/);
    });

    it("instructs the AI to generate insights as JSON", () => {
      expect(INSIGHT_SYSTEM_PROMPT).toMatch(/JSON array/i);
      expect(INSIGHT_SYSTEM_PROMPT).toMatch(/insight/i);
    });

    it("defines insight types", () => {
      expect(INSIGHT_SYSTEM_PROMPT).toMatch(/anomaly/);
      expect(INSIGHT_SYSTEM_PROMPT).toMatch(/trend/);
      expect(INSIGHT_SYSTEM_PROMPT).toMatch(/subscription/);
      expect(INSIGHT_SYSTEM_PROMPT).toMatch(/budget_pace/);
    });

    it("defines severity levels", () => {
      expect(INSIGHT_SYSTEM_PROMPT).toMatch(/info/);
      expect(INSIGHT_SYSTEM_PROMPT).toMatch(/warning/);
      expect(INSIGHT_SYSTEM_PROMPT).toMatch(/alert/);
    });

    it("forbids fabricating data", () => {
      expect(INSIGHT_SYSTEM_PROMPT).toMatch(/not fabricate|do not fabricate/i);
    });
  });

  describe("placeholder prompts", () => {
    it("CATEGORIZATION_SYSTEM_PROMPT is a placeholder", () => {
      expect(CATEGORIZATION_SYSTEM_PROMPT).toContain("TODO");
    });
  });

  describe("FORECAST_SYSTEM_PROMPT", () => {
    it("is a non-empty string", () => {
      expect(typeof FORECAST_SYSTEM_PROMPT).toBe("string");
      expect(FORECAST_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    });

    it("is not a TODO placeholder", () => {
      expect(FORECAST_SYSTEM_PROMPT).not.toMatch(/^TODO/);
    });

    it("instructs the AI to respond with JSON", () => {
      expect(FORECAST_SYSTEM_PROMPT).toMatch(/JSON/i);
    });

    it("defines the monthly projection schema", () => {
      expect(FORECAST_SYSTEM_PROMPT).toMatch(/monthlyProjections/);
      expect(FORECAST_SYSTEM_PROMPT).toMatch(/projectedIncome/);
      expect(FORECAST_SYSTEM_PROMPT).toMatch(/confidenceLow/);
      expect(FORECAST_SYSTEM_PROMPT).toMatch(/confidenceHigh/);
    });

    it("mentions seasonal patterns", () => {
      expect(FORECAST_SYSTEM_PROMPT).toMatch(/seasonal/i);
    });

    it("mentions income variability", () => {
      expect(FORECAST_SYSTEM_PROMPT).toMatch(/income variability/i);
    });

    it("mentions risk flags", () => {
      expect(FORECAST_SYSTEM_PROMPT).toMatch(/riskFlags/);
    });

    it("mentions narrative summary", () => {
      expect(FORECAST_SYSTEM_PROMPT).toMatch(/narrativeSummary/);
    });

    it("forbids fabricating data", () => {
      expect(FORECAST_SYSTEM_PROMPT).toMatch(/not fabricate|do not fabricate/i);
    });
  });
});
