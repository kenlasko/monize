import {
  couponDoc,
  CouponDocOptions,
  Doc,
} from "@/test-helpers/bond-coupon-terms";
import { BondTermsError, parseBondTerms } from "./bond-terms";
import { scheduleDaysOf, scheduleMonthsOf } from "./bond-schedule";

const NOTE: CouponDocOptions = {
  datedDate: "1990-08-15",
  firstCouponDate: "1991-02-15",
  maturityDate: "1992-02-15",
  rate: "0.0675",
};

function refusalOf(doc: Doc): BondTermsError {
  try {
    parseBondTerms(doc);
  } catch (error) {
    expect(error).toBeInstanceOf(BondTermsError);
    return error as BondTermsError;
  }
  throw new Error("expected parseBondTerms to throw");
}

const refused = (change: (doc: Doc) => void, o = NOTE) =>
  refusalOf(couponDoc(o, change));

describe("parseBondTerms: schedule COUPON_DATES", () => {
  it("accepts a coupon note and keeps it exactly as written", () => {
    const doc = couponDoc(NOTE);
    expect(parseBondTerms(doc)).toEqual(doc);
  });

  it.each([3, 6, 12] as const)("accepts %s coupon months", (months) => {
    const terms = parseBondTerms(
      couponDoc({
        datedDate: "2026-01-15",
        firstCouponDate: "2027-01-15",
        maturityDate: "2031-01-15",
        rate: "0.04",
        couponMonths: months,
      }),
    );
    expect(terms.schedule).toMatchObject({ couponMonths: months });
  });

  it.each([0, 1, 2, 4, 5, 9, 24])("refuses %s coupon months", (months) => {
    const error = refused((d) => {
      d.schedule.couponMonths = months;
    });
    expect(error.field).toBe("terms.schedule.couponMonths");
  });

  it("refuses coupon months written as text", () => {
    const error = refused((d) => {
      d.schedule.couponMonths = "6";
    });
    expect(error.field).toBe("terms.schedule.couponMonths");
  });

  it.each([
    "datedDate",
    "firstCouponDate",
    "maturityDate",
    "couponMonths",
    "endOfMonth",
    "paymentAdjustment",
    "calendarId",
  ])("requires %s", (field) => {
    const error = refused((d) => {
      delete d.schedule[field];
    });
    expect(error.field).toBe(`terms.schedule.${field}`);
    expect(error.message).toContain("missing");
  });

  it("refuses an unknown field of the schedule", () => {
    const error = refused((d) => {
      d.schedule.periodCount = 4;
    });
    expect(error.field).toBe("terms.schedule.periodCount");
    expect(error.message).toContain("unknown field");
  });

  it.each(["datedDate", "firstCouponDate", "maturityDate"])(
    "refuses a %s that is not a calendar date",
    (field) => {
      const error = refused((d) => {
        d.schedule[field] = "1991-02-30";
      });
      expect(error.field).toBe(`terms.schedule.${field}`);
    },
  );

  it("refuses endOfMonth that is not a boolean", () => {
    for (const value of ["true", 1, null]) {
      const error = refused((d) => {
        d.schedule.endOfMonth = value;
      });
      expect(error.field).toBe("terms.schedule.endOfMonth");
    }
  });

  it("refuses a payment adjustment it does not know", () => {
    const error = refused((d) => {
      d.schedule.paymentAdjustment = "PREVIOUS_BUSINESS_DAY";
    });
    expect(error.field).toBe("terms.schedule.paymentAdjustment");
  });

  it("refuses a rate written as a number", () => {
    const error = refused((d) => {
      d.rateRule.annualRate = 0.0675;
    });
    expect(error.field).toBe("terms.rateRule.annualRate");
    expect(error.message).toContain("not a number");
  });

  describe("the order of the dates", () => {
    it("refuses a first coupon on the dated date", () => {
      const error = refused((d) => {
        d.schedule.firstCouponDate = d.schedule.datedDate;
      });
      expect(error.field).toBe("terms.schedule.firstCouponDate");
    });

    it("refuses a first coupon before the dated date", () => {
      const error = refused((d) => {
        d.schedule.firstCouponDate = "1990-02-15";
      });
      expect(error.field).toBe("terms.schedule.firstCouponDate");
    });

    it("refuses a maturity before the first coupon", () => {
      const error = refused((d) => {
        d.schedule.maturityDate = "1991-02-14";
      });
      expect(error.field).toBe("terms.schedule.maturityDate");
    });

    it("accepts a first coupon on the maturity (one period)", () => {
      const terms = parseBondTerms(
        couponDoc({ ...NOTE, maturityDate: "1991-02-15" }),
      );
      expect(scheduleMonthsOf(terms.schedule).periodCount).toBe(1);
    });
  });

  describe("the first coupon is a regular date", () => {
    it("refuses a first coupon that is not counted back from the maturity", () => {
      const error = refused((d) => {
        d.schedule.firstCouponDate = "1991-02-16";
      });
      expect(error.field).toBe("terms.schedule.firstCouponDate");
      expect(error.message).toContain("regular coupon date");
    });

    it("refuses the first coupon of the wrong half of the year", () => {
      const error = refused((d) => {
        d.schedule.firstCouponDate = "1991-05-15";
      });
      expect(error.field).toBe("terms.schedule.firstCouponDate");
    });

    it("refuses a first coupon on the 30th when the dates are month ends", () => {
      const error = refused(
        (d) => {
          d.schedule.endOfMonth = true;
        },
        {
          datedDate: "1990-07-02",
          firstCouponDate: "1990-12-30",
          maturityDate: "1992-06-30",
          rate: "0.08375",
        },
      );
      expect(error.field).toBe("terms.schedule.firstCouponDate");
    });

    it("refuses endOfMonth with a maturity that is not a month end", () => {
      const error = refused((d) => {
        d.schedule.endOfMonth = true;
      });
      expect(error.field).toBe("terms.schedule.maturityDate");
    });

    it("refuses a schedule of more periods than any security has", () => {
      const error = refused(() => undefined, {
        datedDate: "1000-01-15",
        firstCouponDate: "1000-04-15",
        maturityDate: "2000-01-15",
        rate: "0.05",
        couponMonths: 3,
      });
      expect(error.field).toBe("terms.schedule.datedDate");
    });
  });

  describe("beside the other primitives", () => {
    it("refuses a ZERO_COUPON_DISCOUNT instrument", () => {
      const error = refused((d) => {
        d.rateRule = { type: "ZERO_COUPON_DISCOUNT" };
        d.instrument.issuePrice = "97";
        d.accrual = { type: "ACTUAL_DAYS_IN_PERIOD" };
      });
      expect(error.field).toBe("terms.schedule.anchor");
      expect(error.message).toContain("ZERO_COUPON_DISCOUNT");
    });

    it("refuses capitalization COMPOUND_AT_PERIOD_END", () => {
      const error = refused((d) => {
        d.capitalization = {
          type: "COMPOUND_AT_PERIOD_END",
          baseRounding: "NONE",
        };
      });
      expect(error.field).toBe("terms.capitalization");
    });

    it.each(["LOT_PURCHASE_DATE", "ISSUE_DATE"])(
      "refuses ACTUAL_ACTUAL_ICMA on a %s schedule",
      (anchor) => {
        const error = refused((d) => {
          d.schedule =
            anchor === "ISSUE_DATE"
              ? {
                  anchor,
                  issueDate: "1990-08-15",
                  maturityDate: "1992-02-15",
                  periodCount: 1,
                  calendarId: "TEST",
                }
              : {
                  anchor,
                  periodMonths: 6,
                  periodCount: 4,
                  rollDay: "ANCHOR_DAY_CLAMPED",
                  calendarId: "TEST",
                };
        });
        expect(error.field).toBe("terms.accrual");
        expect(error.message).toContain("COUPON_DATES");
      },
    );

    it("accepts ACTUAL_DAYS_IN_PERIOD when the first period is regular", () => {
      expect(() =>
        parseBondTerms(
          couponDoc(NOTE, (d) => {
            d.accrual = { type: "ACTUAL_DAYS_IN_PERIOD" };
          }),
        ),
      ).not.toThrow();
    });

    it.each([
      ["short", "1990-09-15"],
      ["long", "1990-07-02"],
    ])(
      "refuses ACTUAL_DAYS_IN_PERIOD when the first period is %s",
      (_kind, datedDate) => {
        const error = refused(
          (d) => {
            d.accrual = { type: "ACTUAL_DAYS_IN_PERIOD" };
          },
          { ...NOTE, datedDate },
        );
        expect(error.field).toBe("terms.accrual");
      },
    );

    it("accepts a coupon schedule on a retail instrument with a sale window", () => {
      expect(() =>
        parseBondTerms(
          couponDoc(NOTE, (d) => {
            d.instrument.marketability = "RETAIL_REDEEMABLE";
            d.saleWindow = { from: "1990-08-01", to: "1990-08-15" };
          }),
        ),
      ).not.toThrow();
    });

    it("keeps refusing an unknown accrual", () => {
      const error = refused((d) => {
        d.accrual = { type: "THIRTY_360" };
      });
      expect(error.code).toBe("UNSUPPORTED_PRIMITIVE");
    });

    it("keeps refusing an ISSUE_DATE schedule on a coupon instrument", () => {
      const error = refused((d) => {
        d.schedule = {
          anchor: "ISSUE_DATE",
          issueDate: "1990-08-15",
          maturityDate: "1992-02-15",
          periodCount: 1,
          calendarId: "TEST",
        };
        d.accrual = { type: "ACTUAL_DAYS_IN_PERIOD" };
      });
      expect(error.field).toBe("terms.schedule.anchor");
    });
  });
});

describe("the length of a coupon schedule", () => {
  it("counts the coupon months and every period", () => {
    const { schedule } = parseBondTerms(couponDoc(NOTE));
    expect(scheduleMonthsOf(schedule)).toEqual({
      periodMonths: 6,
      periodCount: 3,
    });
  });

  it("counts the days from the dated date to the maturity", () => {
    const { schedule } = parseBondTerms(couponDoc(NOTE));
    expect(scheduleDaysOf(schedule)).toBe(549);
  });
});
