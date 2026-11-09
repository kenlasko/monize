import { IsViewDefaultsConstraint } from "./is-view-defaults.validator";
import { VIEW_DEFAULT_FIELDS } from "../view-defaults";

describe("IsViewDefaultsConstraint", () => {
  const validator = new IsViewDefaultsConstraint();

  it("accepts undefined and null (optional)", () => {
    expect(validator.validate(undefined)).toBe(true);
    expect(validator.validate(null)).toBe(true);
  });

  it("accepts an empty object", () => {
    expect(validator.validate({})).toBe(true);
  });

  it("accepts every declared value of every key", () => {
    for (const [key, allowed] of Object.entries(VIEW_DEFAULT_FIELDS)) {
      // A list field holds several of its values; the others hold one.
      const values =
        allowed === "boolean"
          ? [true, false]
          : "list" in allowed
            ? allowed.list.map((item) => [item])
            : [...allowed];
      for (const value of values) {
        expect({
          key,
          value,
          ok: validator.validate({ [key]: value }),
        }).toEqual({ key, value, ok: true });
      }
    }
  });

  it("accepts an empty tab list and up to three distinct tabs", () => {
    expect(validator.validate({ mobileTabs: [] })).toBe(true);
    expect(
      validator.validate({ mobileTabs: ["dashboard", "bills", "settings"] }),
    ).toBe(true);
  });

  it("rejects a tab list that is too long, repeats, or names an unknown tab", () => {
    expect(
      validator.validate({
        mobileTabs: ["dashboard", "bills", "settings", "reports"],
      }),
    ).toBe(false);
    expect(validator.validate({ mobileTabs: ["bills", "bills"] })).toBe(false);
    expect(validator.validate({ mobileTabs: ["more"] })).toBe(false);
    expect(validator.validate({ mobileTabs: "bills" })).toBe(false);
  });

  it("accepts the documented example", () => {
    expect(
      validator.validate({
        density: "compact",
        hideRegisterYear: true,
        widgetsCollapsed: false,
        chartCollapsed: true,
        accountOpenTarget: "register",
      }),
    ).toBe(true);
  });

  it("rejects arrays and non-object top-level values", () => {
    expect(validator.validate([])).toBe(false);
    expect(validator.validate("compact")).toBe(false);
    expect(validator.validate(42)).toBe(false);
    expect(validator.validate(true)).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(validator.validate({ rowDensity: "compact" })).toBe(false);
    expect(validator.validate({ Density: "compact" })).toBe(false);
  });

  it("rejects dangerous keys", () => {
    // Build real own keys (a JSON payload does exactly this); the literal
    // { __proto__: true } would set the prototype instead.
    expect(validator.validate(JSON.parse('{"__proto__": true}'))).toBe(false);
    expect(validator.validate(JSON.parse('{"constructor": true}'))).toBe(false);
    expect(validator.validate(JSON.parse('{"prototype": true}'))).toBe(false);
  });

  it("rejects a value outside an enum", () => {
    expect(validator.validate({ density: "tiny" })).toBe(false);
    expect(validator.validate({ density: "Compact" })).toBe(false);
    expect(validator.validate({ accountOpenTarget: "investments" })).toBe(
      false,
    );
    expect(validator.validate({ density: null })).toBe(false);
  });

  it("rejects a non-boolean flag", () => {
    expect(validator.validate({ chartCollapsed: "true" })).toBe(false);
    expect(validator.validate({ widgetsCollapsed: 1 })).toBe(false);
    expect(validator.validate({ hideRegisterYear: null })).toBe(false);
  });

  it("refuses the whole map when one entry is bad, never dropping it", () => {
    expect(
      validator.validate({ density: "compact", chartCollapsed: "yes" }),
    ).toBe(false);
  });

  it("names the field in its default message", () => {
    expect(validator.defaultMessage()).toContain("viewDefaults");
  });
});
