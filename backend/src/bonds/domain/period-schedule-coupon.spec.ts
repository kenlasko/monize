import {
  buildCouponSchedule,
  CouponDates,
  couponLotPeriods,
  CouponScheduleError,
} from "./period-schedule";

const dates = (
  o: Partial<CouponDates> &
    Pick<CouponDates, "datedDate" | "firstCouponDate" | "maturityDate">,
): CouponDates => ({
  couponMonths: 6,
  endOfMonth: false,
  ...o,
});

const ends = (s: CouponDates) => buildCouponSchedule(s).map((p) => p.end);

describe("buildCouponSchedule (spec 5.1)", () => {
  describe("a regular first period", () => {
    const schedule = dates({
      datedDate: "1990-08-15",
      firstCouponDate: "1991-02-15",
      maturityDate: "1992-02-15",
    });

    it("runs between consecutive regular dates, the last ending on the maturity", () => {
      expect(
        buildCouponSchedule(schedule).map((p) => [
          p.index,
          p.start,
          p.end,
          p.days,
        ]),
      ).toEqual([
        [1, "1990-08-15", "1991-02-15", 184],
        [2, "1991-02-15", "1991-08-15", 181],
        [3, "1991-08-15", "1992-02-15", 184],
      ]);
    });

    it("is regular with one quasi period that is the period itself", () => {
      const [first] = buildCouponSchedule(schedule);
      expect(first.coupon).toEqual({
        kind: "REGULAR",
        quasi: [
          {
            start: "1990-08-15",
            end: "1991-02-15",
            from: "1990-08-15",
            to: "1991-02-15",
          },
        ],
      });
    });
  });

  describe("a short first period (31 CFR 356 App. B I.A example 3)", () => {
    const schedule = dates({
      datedDate: "1990-07-02",
      firstCouponDate: "1990-12-31",
      maturityDate: "1992-06-30",
      endOfMonth: true,
    });

    it("starts on the dated date and keeps the regular period it sits in as its quasi period", () => {
      const [first, second] = buildCouponSchedule(schedule);
      expect(first).toMatchObject({
        index: 1,
        start: "1990-07-02",
        end: "1990-12-31",
        days: 182,
      });
      expect(first.coupon).toEqual({
        kind: "SHORT",
        quasi: [
          {
            start: "1990-06-30",
            end: "1990-12-31",
            from: "1990-07-02",
            to: "1990-12-31",
          },
        ],
      });
      expect(second).toMatchObject({
        index: 2,
        start: "1990-12-31",
        end: "1991-06-30",
      });
      expect(second.coupon?.kind).toBe("REGULAR");
    });
  });

  describe("a long first period (31 CFR 356 App. B I.A example 4)", () => {
    const schedule = dates({
      datedDate: "1990-12-03",
      firstCouponDate: "1991-08-15",
      maturityDate: "1993-08-15",
    });

    it("keeps both regular periods it overlaps as quasi periods, the earlier one clipped", () => {
      const [first] = buildCouponSchedule(schedule);
      expect(first).toMatchObject({
        start: "1990-12-03",
        end: "1991-08-15",
        days: 255,
      });
      expect(first.coupon).toEqual({
        kind: "LONG",
        quasi: [
          {
            start: "1990-08-15",
            end: "1991-02-15",
            from: "1990-12-03",
            to: "1991-02-15",
          },
          {
            start: "1991-02-15",
            end: "1991-08-15",
            from: "1991-02-15",
            to: "1991-08-15",
          },
        ],
      });
    });

    it("has the periods after the first between regular dates", () => {
      expect(ends(schedule)).toEqual([
        "1991-08-15",
        "1992-02-15",
        "1992-08-15",
        "1993-02-15",
        "1993-08-15",
      ]);
    });
  });

  it("is long when the dated date is more than a period before the first coupon, on a regular date", () => {
    const [first] = buildCouponSchedule(
      dates({
        datedDate: "1990-02-15",
        firstCouponDate: "1991-02-15",
        maturityDate: "1992-02-15",
      }),
    );
    expect(first.coupon?.kind).toBe("LONG");
    expect(first.coupon?.quasi.map((q) => [q.start, q.from, q.to])).toEqual([
      ["1990-02-15", "1990-02-15", "1990-08-15"],
      ["1990-08-15", "1990-08-15", "1991-02-15"],
    ]);
  });

  describe("regular dates are generated backwards from the maturity", () => {
    it("takes the last day of the month when endOfMonth: a maturity of 2028-02-29", () => {
      const schedule = dates({
        datedDate: "2026-08-31",
        firstCouponDate: "2027-02-28",
        maturityDate: "2028-02-29",
        endOfMonth: true,
      });
      expect(ends(schedule)).toEqual([
        "2027-02-28",
        "2027-08-31",
        "2028-02-29",
      ]);
    });

    it("takes the last day of the month for quarterly dates too", () => {
      expect(
        ends(
          dates({
            datedDate: "2027-11-30",
            firstCouponDate: "2028-02-29",
            maturityDate: "2028-08-31",
            couponMonths: 3,
            endOfMonth: true,
          }),
        ),
      ).toEqual(["2028-02-29", "2028-05-31", "2028-08-31"]);
    });

    it("clamps the maturity's day to a shorter month without endOfMonth, from the maturity each time", () => {
      expect(
        ends(
          dates({
            datedDate: "2027-02-28",
            firstCouponDate: "2027-08-31",
            maturityDate: "2029-08-31",
          }),
        ),
      ).toEqual([
        "2027-08-31",
        "2028-02-29",
        "2028-08-31",
        "2029-02-28",
        "2029-08-31",
      ]);
    });

    it("a clamped date does not move the next one (30 in June, 31 in December)", () => {
      expect(
        ends(
          dates({
            datedDate: "2027-12-31",
            firstCouponDate: "2028-06-30",
            maturityDate: "2028-12-31",
          }),
        ),
      ).toEqual(["2028-06-30", "2028-12-31"]);
    });

    it("steps by a year for an annual coupon", () => {
      expect(
        ends(
          dates({
            datedDate: "2026-03-15",
            firstCouponDate: "2027-03-15",
            maturityDate: "2030-03-15",
            couponMonths: 12,
          }),
        ),
      ).toEqual(["2027-03-15", "2028-03-15", "2029-03-15", "2030-03-15"]);
    });
  });

  describe("a first coupon that is not a regular date", () => {
    it.each(["1991-02-14", "1991-05-15", "1990-12-15"])(
      "refuses %s",
      (firstCouponDate) => {
        expect(() =>
          buildCouponSchedule(
            dates({
              datedDate: "1990-08-15",
              firstCouponDate,
              maturityDate: "1992-02-15",
            }),
          ),
        ).toThrow(CouponScheduleError);
      },
    );
  });
});

describe("couponLotPeriods", () => {
  const schedule = dates({
    datedDate: "1990-08-15",
    firstCouponDate: "1991-02-15",
    maturityDate: "1992-02-15",
  });

  it("holds every period for a lot bought before the dated date", () => {
    expect(
      couponLotPeriods(schedule, "1990-08-01").map((p) => [p.index, p.end]),
    ).toEqual([
      [1, "1991-02-15"],
      [2, "1991-08-15"],
      [3, "1992-02-15"],
    ]);
  });

  it("holds the period it was bought in, whole, and renumbers from 1", () => {
    const held = couponLotPeriods(schedule, "1991-04-01");
    expect(held.map((p) => [p.index, p.start, p.end])).toEqual([
      [1, "1991-02-15", "1991-08-15"],
      [2, "1991-08-15", "1992-02-15"],
    ]);
  });

  it("drops a period that ended on the purchase date", () => {
    expect(couponLotPeriods(schedule, "1991-02-15").map((p) => p.end)).toEqual([
      "1991-08-15",
      "1992-02-15",
    ]);
  });

  it.each(["1992-02-15", "1993-01-01"])(
    "keeps the last period for a lot bought on or after the maturity (%s)",
    (purchaseDate) => {
      expect(
        couponLotPeriods(schedule, purchaseDate).map((p) => [p.index, p.end]),
      ).toEqual([[1, "1992-02-15"]]);
    },
  );
});
