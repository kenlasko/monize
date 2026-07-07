import { IsDashboardWidgetConfigConstraint } from "./is-dashboard-widget-config.validator";

describe("IsDashboardWidgetConfigConstraint", () => {
  const validator = new IsDashboardWidgetConfigConstraint();

  it("accepts undefined and null (optional)", () => {
    expect(validator.validate(undefined)).toBe(true);
    expect(validator.validate(null)).toBe(true);
  });

  it("accepts an empty object", () => {
    expect(validator.validate({})).toBe(true);
  });

  it("accepts a valid widget config map", () => {
    expect(
      validator.validate({
        "spending-by-payee": { range: "3m" },
        "income-by-source": { range: "1y", chartType: "pie" },
        "sector-weightings": { accountIds: ["a", "b"] },
        "recurring-expenses": { minOccurrences: 3 },
      }),
    ).toBe(true);
  });

  it("rejects arrays at the top level", () => {
    expect(validator.validate([])).toBe(false);
  });

  it("rejects non-object top-level values", () => {
    expect(validator.validate("nope")).toBe(false);
    expect(validator.validate(42)).toBe(false);
  });

  it("rejects widget ids that violate the id pattern", () => {
    expect(validator.validate({ "Bad Id": { range: "3m" } })).toBe(false);
    expect(validator.validate({ UPPER: {} })).toBe(false);
  });

  it("rejects dangerous keys", () => {
    // Build a real own "__proto__" key (a JSON payload does exactly this);
    // the literal { __proto__: {} } would set the prototype instead.
    expect(validator.validate(JSON.parse('{"__proto__": {}}'))).toBe(false);
    expect(validator.validate({ widget: { constructor: "x" } })).toBe(false);
  });

  it("rejects a widget value that is not a flat object", () => {
    expect(validator.validate({ widget: "string" })).toBe(false);
    expect(validator.validate({ widget: [1, 2, 3] })).toBe(false);
    expect(validator.validate({ widget: { nested: { deep: 1 } } })).toBe(false);
  });

  it("rejects arrays of non-primitives inside a widget config", () => {
    expect(validator.validate({ widget: { accountIds: [{ id: "x" }] } })).toBe(
      false,
    );
  });

  it("rejects over-long strings", () => {
    expect(validator.validate({ widget: { range: "x".repeat(101) } })).toBe(
      false,
    );
  });

  it("rejects too many widgets", () => {
    const tooMany: Record<string, unknown> = {};
    for (let i = 0; i < 51; i++) {
      tooMany[`widget-${i}`] = {};
    }
    expect(validator.validate(tooMany)).toBe(false);
  });

  it("rejects too many keys within a single widget", () => {
    const settings: Record<string, unknown> = {};
    for (let i = 0; i < 21; i++) {
      settings[`k${i}`] = i;
    }
    expect(validator.validate({ widget: settings })).toBe(false);
  });

  it("rejects over-long arrays", () => {
    const big = Array.from({ length: 201 }, (_, i) => String(i));
    expect(validator.validate({ widget: { accountIds: big } })).toBe(false);
  });

  it("has a helpful default message", () => {
    expect(validator.defaultMessage()).toContain("dashboardWidgetConfig");
  });
});
