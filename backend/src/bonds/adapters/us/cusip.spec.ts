import { SeriesFetchError } from "../../bond-adapter";
import {
  cusipCheckDigit,
  isValidCusip,
  parseSeriesCode,
  programOf,
} from "./cusip";

describe("CUSIP check digit", () => {
  it.each(["912797WM5", "91282CQM6", "037833100", "17275R102", "38259P508"])(
    "accepts the real CUSIP %s",
    (cusip) => {
      expect(isValidCusip(cusip)).toBe(true);
    },
  );

  it("computes the digit of the first eight characters", () => {
    expect(cusipCheckDigit("912797WM")).toBe(5);
    expect(cusipCheckDigit("91282CQM")).toBe(6);
  });

  it("counts * @ # as 36 37 38", () => {
    // 0*@#0000 : values 0, 36x2=72, 37, 38x2=76, 0, 0, 0, 0 -> 0+9+3+7+7+6 = 32
    expect(cusipCheckDigit("0*@#0000")).toBe(8);
  });

  it.each(["912797WM4", "91282CQM0", "912797WM", "912797wm5", "91279 WM5"])(
    "refuses %s",
    (value) => {
      expect(isValidCusip(value)).toBe(false);
    },
  );
});

describe("series code grammar", () => {
  it("reads a coupon security's CUSIP, upper-casing it", () => {
    expect(parseSeriesCode("91282cqm6")).toEqual({
      code: "91282CQM6",
      cusip: "91282CQM6",
      issueDate: null,
    });
  });

  it("reads a bill's CUSIP and issue date", () => {
    expect(parseSeriesCode("912797WM5261001")).toEqual({
      code: "912797WM5261001",
      cusip: "912797WM5",
      issueDate: "2026-10-01",
    });
  });

  it.each([
    "",
    "912797WM4",
    "912797WM5261301",
    "912797WM5260230",
    "912797WM52610",
    "912797WM5261001X",
    "912797WM5-61001",
    "12345678901234567",
  ])("refuses %j as SERIES_CODE_INVALID", (code) => {
    let thrown: unknown;
    try {
      parseSeriesCode(code);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SeriesFetchError);
    expect((thrown as SeriesFetchError).code).toBe("SERIES_CODE_INVALID");
  });

  it("refuses what is not a string", () => {
    expect(() => parseSeriesCode(5)).toThrow(SeriesFetchError);
    expect(() => parseSeriesCode(undefined)).toThrow(SeriesFetchError);
  });

  it("echoes only letters and digits of a bad code", () => {
    try {
      parseSeriesCode("<script>");
    } catch (error) {
      expect((error as SeriesFetchError).params).toEqual({ seriesCode: "" });
    }
  });
});

describe("programOf", () => {
  it("names a bill by its 15-character code", () => {
    expect(programOf("912797WM5261001")).toBe("BILL");
  });

  it("knows nothing of a coupon CUSIP, a bad code or another prefix", () => {
    expect(programOf("91282CQM6")).toBeNull();
    expect(programOf("912797WM5")).toBeNull();
    expect(programOf("912797WM4261001")).toBeNull();
    expect(programOf("91282CQM6261001")).toBeNull();
    expect(programOf("EDO1036")).toBeNull();
  });
});
