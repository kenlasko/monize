import { BadRequestException } from "@nestjs/common";
import { readFileSync } from "fs";
import { join } from "path";
import { todayYMD } from "../common/date-utils";
import {
  MAX_REDEMPTION_QUANTITY,
  ParseAssumePipe,
  ParseBondAsOfPipe,
  ParseBenchmarkIdPipe,
  ParseBondCountryCodePipe,
  ParseBondQuantityPipe,
  ParseOptionalProgramCodePipe,
  ParseScenarioValuesPipe,
} from "./bond-query.pipes";

describe("ParseAssumePipe", () => {
  const pipe = new ParseAssumePipe();

  it("is no assumption when the key is absent or empty", () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform("")).toBeUndefined();
  });

  it.each(["PL_CPI_GUS_YOY:0.05", "X:-0.5", "X:1.0", "X:1", "A1_B:0"])(
    "accepts %s",
    (text) => {
      const [id, value] = text.split(":");
      expect(pipe.transform(text)).toEqual(new Map([[id, value]]));
    },
  );

  it.each([
    "PL_CPI_GUS_YOY",
    ":0.05",
    "pl_cpi:0.05",
    "X:",
    "X:abc",
    "X:0.05:1",
    "X:-0.51",
    "X:1.01",
    "X:1e-1",
    " X:0.05",
    `${"A".repeat(41)}:0.05`,
    "X:0.05'; DROP TABLE a",
  ])("refuses %s with a 400", (text) => {
    expect(() => pipe.transform(text)).toThrow(BadRequestException);
  });

  it("refuses a repeated key (an array), not coerces it", () => {
    expect(() => pipe.transform(["X:0.05", "X:0.06"])).toThrow(
      BadRequestException,
    );
  });
});

describe("ParseBenchmarkIdPipe", () => {
  const pipe = new ParseBenchmarkIdPipe();

  it("accepts 1 to 40 capital letters, digits and underscores", () => {
    expect(pipe.transform("PL_CPI_GUS_YOY")).toBe("PL_CPI_GUS_YOY");
    expect(pipe.transform("A".repeat(40))).toBe("A".repeat(40));
  });

  it.each([undefined, "", "a", "A-B", "A".repeat(41), ["A", "B"]])(
    "refuses %p",
    (value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    },
  );
});

describe("ParseScenarioValuesPipe", () => {
  const pipe = new ParseScenarioValuesPipe();

  it("splits 1 to 6 bounded decimals, keeping the text", () => {
    expect(pipe.transform("0.025")).toEqual(["0.025"]);
    expect(pipe.transform("0, 0.025,0.05,0.08,-0.5,1.0")).toEqual([
      "0",
      "0.025",
      "0.05",
      "0.08",
      "-0.5",
      "1.0",
    ]);
  });

  it.each([
    undefined,
    "",
    "0,",
    "0,,1",
    "a",
    "0.05,1.5",
    "-0.6",
    "0,0,0,0,0,0,0",
    ["0", "1"],
  ])("refuses %p", (value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });
});

describe("ParseBondAsOfPipe", () => {
  const pipe = new ParseBondAsOfPipe();

  const addDays = (ymd: string, days: number): string => {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  it("is no date when absent, and accepts today and earlier days", () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform(todayYMD())).toBe(todayYMD());
    expect(pipe.transform("2020-01-31")).toBe("2020-01-31");
  });

  it("refuses tomorrow with a 400 naming the date, in the message of AS_OF_IN_FUTURE", () => {
    const tomorrow = addDays(todayYMD(), 1);
    expect(() => pipe.transform(tomorrow)).toThrow(BadRequestException);
    expect(() => pipe.transform(tomorrow)).toThrow(
      `The valuation date ${tomorrow} is after today`,
    );
  });

  it("refuses a date that is not a calendar date", () => {
    expect(() => pipe.transform("2026-02-30")).toThrow(BadRequestException);
  });
});

describe("ParseBondCountryCodePipe", () => {
  const pipe = new ParseBondCountryCodePipe();

  it("accepts two letters and upper-cases them", () => {
    expect(pipe.transform("PL")).toBe("PL");
    expect(pipe.transform("pl")).toBe("PL");
  });

  it.each([undefined, "", "P", "POL", "P1", ["PL", "DE"], 42, null, "PL "])(
    "refuses %p with a 400",
    (value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    },
  );
});

describe("ParseOptionalProgramCodePipe", () => {
  const pipe = new ParseOptionalProgramCodePipe();

  it("is every program when absent or empty", () => {
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(pipe.transform("")).toBeUndefined();
  });

  it.each(["EDO", "A", "ABC123456789"])("accepts %s", (value) => {
    expect(pipe.transform(value)).toBe(value);
  });

  it.each(["edo", "ABC1234567890", "E-O", ["EDO", "COI"], 7, "EDO'; --"])(
    "refuses %p with a 400",
    (value) => {
      expect(() => pipe.transform(value)).toThrow(BadRequestException);
    },
  );
});

describe("ParseBondQuantityPipe", () => {
  const pipe = new ParseBondQuantityPipe();

  it("answers a positive whole number of bonds written as plain digits", () => {
    expect(pipe.transform("1")).toBe("1");
    expect(pipe.transform("240")).toBe("240");
    expect(pipe.transform("3910")).toBe("3910");
    expect(pipe.transform("1000000000")).toBe("1000000000");
  });

  it.each([
    undefined,
    "",
    "0",
    "-1",
    "1.5",
    "01",
    "1e3",
    "0x10",
    "1.000",
    "2.9999999999999999",
    " 4",
    "4,5",
    "1000000001",
    "9999999999",
    "99999999999",
    ["1", "2"],
    4,
    null,
  ])("refuses %p with a 400", (value) => {
    expect(() => pipe.transform(value)).toThrow(BadRequestException);
  });

  it("names the refused text, and nothing for a value that is not text", () => {
    const messageOf = (value: unknown) => {
      try {
        pipe.transform(value);
      } catch (error) {
        return (error as BadRequestException).message;
      }
      throw new Error("expected a refusal");
    };
    expect(messageOf("1e3")).toMatch(/bonds: 1e3$/);
    expect(messageOf(4)).toMatch(/bonds: $/);
  });

  it("bounds the quantity where the REDEEM form says it does", () => {
    // The form names the bound in the message it shows for QUANTITY_INVALID.
    const frontend = readFileSync(
      join(
        __dirname,
        "../../../frontend/src/components/investments/useBondRedemptionSplit.ts",
      ),
      "utf8",
    );
    const declared = frontend.match(/MAX_REDEMPTION_QUANTITY\s*=\s*([\d_]+)/);
    expect(declared).not.toBeNull();
    expect(Number(declared![1].replace(/_/g, ""))).toBe(
      MAX_REDEMPTION_QUANTITY,
    );
  });

  it("carries QUANTITY_INVALID as its errorCode, so a client can tell it from a failed request", () => {
    try {
      pipe.transform("0");
    } catch (error) {
      expect((error as BadRequestException).getResponse()).toEqual({
        message: "The quantity must be a positive whole number of bonds: 0",
        errorCode: "QUANTITY_INVALID",
      });
      return;
    }
    throw new Error("expected a refusal");
  });
});
