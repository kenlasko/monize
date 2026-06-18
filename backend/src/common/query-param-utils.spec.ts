import { BadRequestException } from "@nestjs/common";
import {
  UUID_REGEX,
  DATE_REGEX,
  parseIds,
  parseUuids,
  parseCategoryIds,
  validateDateParam,
  assertStringParam,
} from "./query-param-utils";

const VALID_UUID = "11111111-2222-3333-4444-555555555555";
const VALID_UUID_2 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("UUID_REGEX / DATE_REGEX", () => {
  it("matches a canonical UUID", () => {
    expect(UUID_REGEX.test(VALID_UUID)).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    expect(UUID_REGEX.test("not-a-uuid")).toBe(false);
  });

  it("DATE_REGEX matches YYYY-MM-DD", () => {
    expect(DATE_REGEX.test("2026-04-15")).toBe(true);
  });

  it("DATE_REGEX rejects malformed dates", () => {
    expect(DATE_REGEX.test("4/15/2026")).toBe(false);
  });
});

describe("parseIds()", () => {
  it("returns undefined when neither parameter is provided", () => {
    expect(parseIds()).toBeUndefined();
  });

  it("parses a comma-separated list of UUIDs from the plural param", () => {
    const result = parseIds(`${VALID_UUID},${VALID_UUID_2}`);
    expect(result).toEqual([VALID_UUID, VALID_UUID_2]);
  });

  it("trims whitespace and skips empty entries", () => {
    const result = parseIds(`  ${VALID_UUID}  ,, ${VALID_UUID_2}`);
    expect(result).toEqual([VALID_UUID, VALID_UUID_2]);
  });

  it("returns undefined when the plural param is empty after filtering", () => {
    expect(parseIds(",,")).toBeUndefined();
  });

  it("throws BadRequestException for an invalid UUID in the plural param", () => {
    expect(() => parseIds(`${VALID_UUID},bad`)).toThrow(BadRequestException);
  });

  it("falls back to the singular param when plural is missing", () => {
    expect(parseIds(undefined, VALID_UUID)).toEqual([VALID_UUID]);
  });

  it("throws for an invalid UUID in the singular param", () => {
    expect(() => parseIds(undefined, "bad-uuid")).toThrow(BadRequestException);
  });
});

describe("parseUuids()", () => {
  it("returns undefined for empty input", () => {
    expect(parseUuids()).toBeUndefined();
    expect(parseUuids("")).toBeUndefined();
  });

  it("parses a single UUID", () => {
    expect(parseUuids(VALID_UUID)).toEqual([VALID_UUID]);
  });

  it("parses comma-separated UUIDs and trims whitespace", () => {
    expect(parseUuids(`${VALID_UUID} , ${VALID_UUID_2}`)).toEqual([
      VALID_UUID,
      VALID_UUID_2,
    ]);
  });

  it("returns undefined when input is only whitespace and commas", () => {
    expect(parseUuids("  , ,")).toBeUndefined();
  });

  it("throws BadRequestException when any value is not a UUID", () => {
    expect(() => parseUuids(`${VALID_UUID},nope`)).toThrow(BadRequestException);
  });
});

describe("parseCategoryIds()", () => {
  it("returns undefined for empty input", () => {
    expect(parseCategoryIds()).toBeUndefined();
    expect(parseCategoryIds("")).toBeUndefined();
  });

  it("accepts the special 'uncategorized' value", () => {
    expect(parseCategoryIds("uncategorized")).toEqual(["uncategorized"]);
  });

  it("accepts the special 'transfer' value", () => {
    expect(parseCategoryIds("transfer")).toEqual(["transfer"]);
  });

  it("accepts the special 'investment-income' value", () => {
    expect(parseCategoryIds("investment-income")).toEqual([
      "investment-income",
    ]);
  });

  it("accepts a mix of UUIDs and special values", () => {
    expect(parseCategoryIds(`${VALID_UUID},uncategorized`)).toEqual([
      VALID_UUID,
      "uncategorized",
    ]);
  });

  it("returns undefined when input becomes empty after filtering", () => {
    expect(parseCategoryIds(", ,")).toBeUndefined();
  });

  it("throws for invalid category IDs", () => {
    expect(() => parseCategoryIds("not-a-uuid")).toThrow(BadRequestException);
  });
});

describe("validateDateParam()", () => {
  it("does nothing when value is undefined", () => {
    expect(() => validateDateParam(undefined, "from")).not.toThrow();
  });

  it("accepts a YYYY-MM-DD value", () => {
    expect(() => validateDateParam("2026-04-15", "from")).not.toThrow();
  });

  it("rejects a malformed date with a parameter-aware message", () => {
    expect(() => validateDateParam("04/15/2026", "from")).toThrow(
      /from must be a valid date/,
    );
  });
});

describe("assertStringParam()", () => {
  it("returns undefined for undefined input", () => {
    expect(assertStringParam(undefined, "q")).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(assertStringParam(null, "q")).toBeUndefined();
  });

  it("returns the original string when input is a string", () => {
    expect(assertStringParam("hello", "q")).toBe("hello");
  });

  it("throws BadRequestException for array values (express duplicated keys)", () => {
    expect(() => assertStringParam(["a", "b"], "q")).toThrow(
      BadRequestException,
    );
  });

  it("throws BadRequestException for object values (bracket syntax)", () => {
    expect(() => assertStringParam({ injected: 1 }, "q")).toThrow(
      BadRequestException,
    );
  });
});
