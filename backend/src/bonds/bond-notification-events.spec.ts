import {
  NotificationSeverity,
  NotificationType,
} from "../notification-center/entities/notification.entity";
import { DEDUPE_KEY_MAX_LENGTH } from "../notification-center/notification-bounds";
import {
  BOND_BENCHMARK_AFFECTED_LIMIT,
  BenchmarkObservation,
  affectedSeriesOf,
  benchmarkPublishedNotification,
  bondDedupeKeys,
  buildInterestNotification,
  buildMaturitySoonNotification,
  buildRedemptionUnbookedNotification,
  interestCandidates,
  maturitySoonCandidates,
  missingCausesOf,
  missingDataNotification,
  payoutOf,
  rateResetNotifications,
  unbookedCandidates,
  unknownPayout,
} from "./bond-notification-events";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  SECURITY,
  SERIES_1,
  SERIES_2,
  TODAY,
  flow,
  lot,
  security,
} from "../test-helpers/bond-valuation-fixtures";
import { BondRedemptionSplit } from "./bond-holdings.service";
import { BondValuation, RateScheduleEntry } from "./engine/bond-engine";
import { CashFlow } from "./engine/bond-engine-types";

const knownSplit: BondRedemptionSplit = {
  date: "2026-10-25",
  quantity: 40,
  principal: "4000.00",
  grossInterest: "123.45",
  deduction: "0.00",
  interest: "123.45",
  principalReturned: "4000.00",
  payout: "4123.45",
  refusal: null,
};

describe("item 1, maturity soon", () => {
  const held = (maturityDate: string, quantity = 40) =>
    security([lot({ quantity, valuation: { maturityDate, quantity } })]);

  it("raises the maturity of a held series with the engine's payout", () => {
    const v = held("2026-10-25");
    const [candidate] = maturitySoonCandidates(v, TODAY);
    expect(candidate).toMatchObject({
      accountId: ACCOUNT_A,
      instrumentId: SERIES_1,
      maturityDate: "2026-10-25",
      quantity: 40,
    });
    const input = buildMaturitySoonNotification(
      v,
      candidate,
      payoutOf(knownSplit),
    );
    expect(input.type).toBe(NotificationType.BOND_MATURITY_SOON);
    expect(input.severity).toBe(NotificationSeverity.INFO);
    expect(input.target).toBe(`/securities/${SECURITY}`);
    expect(input.dedupeKey).toBe(
      `bond:maturity:${ACCOUNT_A}:${SERIES_1}:2026-10-25`,
    );
    expect(input.data).toEqual({
      securityId: SECURITY,
      accountId: ACCOUNT_A,
      instrumentId: SERIES_1,
      seriesCode: "SER0001",
      currency: "EUR",
      maturityDate: "2026-10-25",
      quantity: 40,
      payout: "4123.45",
      interest: "123.45",
      principalReturned: "4000.00",
      missing: null,
    });
  });

  it("keeps the key the next day, so the second run raises nothing new", () => {
    const first = maturitySoonCandidates(held("2026-10-25"), "2026-10-13")[0];
    const next = maturitySoonCandidates(held("2026-10-25"), "2026-10-14")[0];
    expect(
      bondDedupeKeys.maturity(
        next.accountId,
        next.instrumentId,
        next.maturityDate,
      ),
    ).toBe(
      bondDedupeKeys.maturity(
        first.accountId,
        first.instrumentId,
        first.maturityDate,
      ),
    );
  });

  it("includes T+14 and excludes T+15, and never the day itself", () => {
    expect(maturitySoonCandidates(held("2026-10-27"), TODAY)).toHaveLength(1);
    expect(maturitySoonCandidates(held("2026-10-28"), TODAY)).toHaveLength(0);
    expect(maturitySoonCandidates(held("2026-10-13"), TODAY)).toHaveLength(0);
  });

  it("ignores a lot that has already matured", () => {
    const v = security([
      lot({ valuation: { status: "MATURED", maturityDate: "2026-10-20" } }),
    ]);
    expect(maturitySoonCandidates(v, TODAY)).toHaveLength(0);
  });

  it("sums the lots of one series and account, and keeps accounts apart", () => {
    const v = security([
      lot({ quantity: 10, valuation: { maturityDate: "2026-10-25" } }),
      lot({ quantity: 5, valuation: { maturityDate: "2026-10-25" } }),
      lot({
        accountId: ACCOUNT_B,
        quantity: 7,
        valuation: { maturityDate: "2026-10-25" },
      }),
    ]);
    const candidates = maturitySoonCandidates(v, TODAY);
    expect(candidates.map((c) => [c.accountId, c.quantity])).toEqual([
      [ACCOUNT_A, 15],
      [ACCOUNT_B, 7],
    ]);
  });

  it("carries null figures and the refusal code when the split is refused, never zero", () => {
    const v = held("2026-10-25");
    const [candidate] = maturitySoonCandidates(v, TODAY);
    const refused = payoutOf({
      ...knownSplit,
      payout: null,
      interest: null,
      principalReturned: null,
      refusal: "RATE_UNKNOWN",
    });
    const input = buildMaturitySoonNotification(v, candidate, refused);
    expect(input.data).toMatchObject({
      payout: null,
      interest: null,
      principalReturned: null,
      missing: "RATE_UNKNOWN",
    });
    const thrown = buildMaturitySoonNotification(
      v,
      candidate,
      unknownPayout("OVER_REMOVAL"),
    );
    expect(thrown.data).toMatchObject({
      payout: null,
      missing: "OVER_REMOVAL",
    });
  });
});

describe("item 2, interest payment", () => {
  /** A lot valued as of the window start, with the engine's flows after it. */
  const paying = (
    flows: CashFlow[] = [flow()],
    over: Partial<BondValuation> = {},
    quantity = 10,
  ) =>
    lot({
      quantity,
      valuation: {
        asOf: "2026-10-10",
        knownCashflows: flows.filter((f) => f.status === "KNOWN"),
        projectedCashflows: flows.filter((f) => f.status !== "KNOWN"),
        maturityDate: "2029-10-13",
        ...over,
      },
    });
  const atWindowStart = (lots: ReturnType<typeof paying>[]) =>
    security(lots, { asOf: "2026-10-10" });

  it("raises the day's interest of a series, summed over its lots", () => {
    const [candidate] = interestCandidates(atWindowStart([paying()]), TODAY);
    expect(candidate).toMatchObject({
      accountId: ACCOUNT_A,
      instrumentId: SERIES_1,
      paymentDate: TODAY,
      quantity: 10,
      amount: "51.00",
    });
    const input = buildInterestNotification(security([]), candidate);
    expect(input.type).toBe(NotificationType.BOND_INTEREST_PAYMENT);
    expect(input.dedupeKey).toBe(
      `bond:interest:${ACCOUNT_A}:${SERIES_1}:${TODAY}`,
    );
    expect(input.data).toMatchObject({
      paymentDate: TODAY,
      amount: "51.00",
      quantity: 10,
    });

    const two = atWindowStart([paying(), paying([flow()], {}, 4)]);
    expect(interestCandidates(two, TODAY)[0]).toMatchObject({
      quantity: 14,
      amount: "102.00",
    });
  });

  it("looks back three days: T-3 is excluded, T-2 and T-1 are included", () => {
    const flows = (date: string) => atWindowStart([paying([flow({ date })])]);
    expect(interestCandidates(flows("2026-10-10"), TODAY)).toHaveLength(0);
    const [skipped] = interestCandidates(flows("2026-10-11"), TODAY);
    expect(skipped).toMatchObject({
      paymentDate: "2026-10-11",
      amount: "51.00",
    });
    expect(buildInterestNotification(security([]), skipped).dedupeKey).toBe(
      `bond:interest:${ACCOUNT_A}:${SERIES_1}:2026-10-11`,
    );
    expect(interestCandidates(flows("2026-10-12"), TODAY)).toHaveLength(1);
    // Tomorrow is not yet due.
    expect(interestCandidates(flows("2026-10-14"), TODAY)).toHaveLength(0);
  });

  it("raises one row per day when two paying days fall in the window", () => {
    const v = atWindowStart([
      paying([flow({ date: "2026-10-11" })]),
      paying([flow({ date: TODAY })]),
    ]);
    expect(interestCandidates(v, TODAY).map((c) => c.paymentDate)).toEqual([
      "2026-10-11",
      TODAY,
    ]);
  });

  it("excludes the maturity day, which is items 1 and 4", () => {
    const v = atWindowStart([
      paying([flow(), flow({ type: "PRINCIPAL", amount: "1000.00" })], {
        maturityDate: TODAY,
      }),
    ]);
    expect(interestCandidates(v, TODAY)).toHaveLength(0);
  });

  it("ignores a principal-only flow and a flow on another day", () => {
    expect(
      interestCandidates(
        atWindowStart([paying([flow({ type: "PRINCIPAL" })])]),
        TODAY,
      ),
    ).toHaveLength(0);
    expect(
      interestCandidates(
        atWindowStart([paying([flow({ date: "2026-10-14" })])]),
        TODAY,
      ),
    ).toHaveLength(0);
  });

  it("keeps the amount null when a flow is unknown, whatever the other lots pay", () => {
    const v = atWindowStart([
      paying(),
      paying([flow({ amount: null, status: "UNKNOWN" })]),
    ]);
    const [candidate] = interestCandidates(v, TODAY);
    expect(candidate.amount).toBeNull();
    expect(
      buildInterestNotification(security([]), candidate).data,
    ).toMatchObject({
      amount: null,
    });
  });

  it("sums a projected flow as the engine's figure", () => {
    const v = atWindowStart([
      paying([flow({ status: "PROJECTED", amount: "12.50" })]),
    ]);
    expect(interestCandidates(v, TODAY)[0].amount).toBe("12.50");
  });
});

describe("item 3, new interest period", () => {
  const entering = (
    rateSource: "DERIVED" | "ANNOUNCED" | "TERMS" | "PROJECTED" | null,
    index = 2,
    annualRate: string | null = "0.069",
  ) => {
    const entry: RateScheduleEntry = {
      index,
      start: TODAY,
      end: "2027-10-13",
      annualRate,
      rateSource,
      benchmark: {
        benchmarkId: "BENCH_A",
        observation: "2026-08",
        value: "0.049",
        flooredValue: "0.049",
      },
      addend: "0.02",
      interest: null,
      fixedPart: null,
      benchmarkPart: null,
      addendPart: null,
      announcedPart: null,
    };
    return lot({
      valuation: {
        currentPeriod: {
          index,
          start: TODAY,
          end: "2027-10-13",
          annualRate,
          rateSource,
        },
        rateSchedule: [entry],
      },
    });
  };

  it("raises a derived rate with the benchmark facts of its schedule entry", () => {
    const [input] = rateResetNotifications(
      security([entering("DERIVED")]),
      TODAY,
    );
    expect(input.type).toBe(NotificationType.BOND_RATE_RESET);
    expect(input.dedupeKey).toBe(`bond:rate:${ACCOUNT_A}:${SERIES_1}:${TODAY}`);
    expect(input.data).toMatchObject({
      periodStart: TODAY,
      periodEnd: "2027-10-13",
      periodIndex: 2,
      annualRate: "0.069",
      rateSource: "DERIVED",
      benchmarkId: "BENCH_A",
      observation: "2026-08",
      benchmarkValue: "0.049",
      addend: "0.02",
    });
  });

  it("raises an announced rate", () => {
    expect(
      rateResetNotifications(security([entering("ANNOUNCED")]), TODAY),
    ).toHaveLength(1);
  });

  it("excludes a fixed or terms rate, a projection, the first period and another day", () => {
    expect(
      rateResetNotifications(security([entering("TERMS")]), TODAY),
    ).toHaveLength(0);
    expect(
      rateResetNotifications(security([entering("PROJECTED")]), TODAY),
    ).toHaveLength(0);
    expect(
      rateResetNotifications(security([entering("DERIVED", 1)]), TODAY),
    ).toHaveLength(0);
    // The period starts after the day asked about.
    expect(
      rateResetNotifications(security([entering("DERIVED")]), "2026-10-12"),
    ).toHaveLength(0);
  });

  it("looks back three days: a start at T-3 is excluded, T-2 and T-1 are included", () => {
    const at = (today: string) =>
      rateResetNotifications(security([entering("DERIVED")]), today);
    // The period started on TODAY (2026-10-13).
    expect(at("2026-10-14")).toHaveLength(1);
    expect(at("2026-10-15")).toHaveLength(1);
    expect(at("2026-10-16")).toHaveLength(0);
    // Date-scoped key: the late read writes the row the on-time one would have.
    expect(at("2026-10-15")[0].dedupeKey).toBe(
      `bond:rate:${ACCOUNT_A}:${SERIES_1}:${TODAY}`,
    );
  });

  it("is not raised when the rate is null; item 6 reports it", () => {
    const unknown = lot({
      valuation: {
        currentPeriod: {
          index: 2,
          start: TODAY,
          end: "2027-10-13",
          annualRate: null,
          rateSource: null,
        },
        missing: [
          {
            benchmarkId: "BENCH_A",
            observation: "2026-08",
            publisher: "Publisher",
          },
        ],
      },
    });
    const v = security([unknown]);
    expect(rateResetNotifications(v, TODAY)).toHaveLength(0);
    expect(missingDataNotification(v)?.data?.causes).toEqual([
      {
        code: "OBSERVATION_MISSING",
        benchmarkId: "BENCH_A",
        observation: "2026-08",
        publisher: "Publisher",
      },
    ]);
  });

  it("raises one row per account and series", () => {
    const v = security([
      entering("DERIVED"),
      entering("DERIVED"),
      { ...entering("DERIVED"), accountId: ACCOUNT_B },
    ]);
    expect(rateResetNotifications(v, TODAY)).toHaveLength(2);
  });
});

describe("item 4, matured and not redeemed", () => {
  const matured = security([
    lot({
      quantity: 5,
      valuation: {
        status: "MATURED",
        maturityDate: "2026-10-01",
        currentPeriod: null,
      },
    }),
  ]);

  it("raises a matured lot once, as a warning with the maturity split", () => {
    const [candidate] = unbookedCandidates(matured);
    expect(candidate).toMatchObject({
      maturityDate: "2026-10-01",
      quantity: 5,
    });
    const input = buildRedemptionUnbookedNotification(
      matured,
      candidate,
      payoutOf({
        ...knownSplit,
        payout: "500.00",
        interest: "0.00",
        principalReturned: "500.00",
      }),
    );
    expect(input.type).toBe(NotificationType.BOND_REDEMPTION_UNBOOKED);
    expect(input.severity).toBe(NotificationSeverity.WARNING);
    expect(input.dedupeKey).toBe(
      `bond:unbooked:${ACCOUNT_A}:${SERIES_1}:2026-10-01`,
    );
    expect(input.data).toMatchObject({
      maturityDate: "2026-10-01",
      quantity: 5,
      payout: "500.00",
    });
  });

  it("does not take an open lot", () => {
    expect(unbookedCandidates(security([lot()]))).toHaveLength(0);
  });
});

describe("item 5, benchmark published", () => {
  const observation: BenchmarkObservation = {
    benchmarkId: "BENCH_A",
    publisher: "Publisher",
    observation: "2026-09",
    value: "0.049",
    unit: "RATE_FRACTION",
    publishedOn: "2026-10-13",
  };
  const reading = (
    seriesCode: string,
    instrumentId: string,
    start = "2026-11-01",
  ) =>
    lot({
      instrumentId,
      valuation: {
        seriesCode,
        rateRule: {
          type: "BENCHMARK_PLUS_SPREAD",
          benchmarkId: "BENCH_A",
          annualRate: null,
          firstPeriodRate: null,
          addend: "0.02",
          benchmarkFloor: null,
        },
        rateSchedule: [
          {
            index: 1,
            start: "2025-11-01",
            end: start,
            annualRate: "0.05",
            rateSource: "DERIVED",
            benchmark: null,
            addend: null,
            interest: null,
            fixedPart: null,
            benchmarkPart: null,
            addendPart: null,
            announcedPart: null,
          },
          {
            index: 2,
            start,
            end: "2027-11-01",
            annualRate: null,
            rateSource: null,
            benchmark: null,
            addend: null,
            interest: null,
            fixedPart: null,
            benchmarkPart: null,
            addendPart: null,
            announcedPart: null,
          },
        ],
      },
    });

  it("lists each held series reading the benchmark with its first period from today on", () => {
    const affected = affectedSeriesOf(
      [
        security([
          reading("SER0002", SERIES_2),
          reading("SER0001", SERIES_1),
          lot(),
        ]),
      ],
      "BENCH_A",
      TODAY,
    );
    expect(affected.map((a) => a.entry)).toEqual([
      {
        instrumentId: SERIES_1,
        seriesCode: "SER0001",
        periodStart: "2026-11-01",
        annualRate: null,
        rateSource: null,
      },
      {
        instrumentId: SERIES_2,
        seriesCode: "SER0002",
        periodStart: "2026-11-01",
        annualRate: null,
        rateSource: null,
      },
    ]);
    const input = benchmarkPublishedNotification(
      observation,
      affected,
    ) as NonNullable<ReturnType<typeof benchmarkPublishedNotification>>;
    expect(input.type).toBe(NotificationType.BOND_BENCHMARK_PUBLISHED);
    expect(input.dedupeKey).toBe("bond:bench:BENCH_A:2026-09");
    expect(input.target).toBe(`/securities/${SECURITY}`);
    expect(input.data).toMatchObject({
      securityId: null,
      accountId: null,
      benchmarkId: "BENCH_A",
      publisher: "Publisher",
      observation: "2026-09",
      value: "0.049",
      publishedOn: "2026-10-13",
      affectedMore: 0,
    });
  });

  it("raises nothing when no held open series reads it", () => {
    const affected = affectedSeriesOf([security([lot()])], "BENCH_A", TODAY);
    expect(affected).toEqual([]);
    expect(benchmarkPublishedNotification(observation, affected)).toBeNull();
    const closed = reading("SER0001", SERIES_1);
    expect(
      affectedSeriesOf(
        [
          security([
            {
              ...closed,
              valuation: { ...closed.valuation, status: "MATURED" },
            },
          ]),
        ],
        "BENCH_A",
        TODAY,
      ),
    ).toEqual([]);
  });

  it("lists at most 20 series and counts the rest", () => {
    const many = Array.from({ length: 23 }, (_, i) =>
      reading(
        `SER${String(i).padStart(4, "0")}`,
        `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      ),
    );
    const input = benchmarkPublishedNotification(
      observation,
      affectedSeriesOf([security(many)], "BENCH_A", TODAY),
    ) as NonNullable<ReturnType<typeof benchmarkPublishedNotification>>;
    expect((input.data?.affected as unknown[]).length).toBe(
      BOND_BENCHMARK_AFFECTED_LIMIT,
    );
    expect(input.data?.affectedMore).toBe(3);
  });

  it("is keyed by benchmark and observation, so a later one is a new row", () => {
    expect(bondDedupeKeys.benchmark("BENCH_A", "2026-09")).not.toBe(
      bondDedupeKeys.benchmark("BENCH_A", "2026-10"),
    );
    expect(bondDedupeKeys.benchmark("BENCH_A", "2026-09")).not.toBe(
      bondDedupeKeys.benchmark("BENCH_B", "2026-09"),
    );
  });
});

describe("item 6, missing data", () => {
  const missingObservation = {
    benchmarkId: "BENCH_A",
    observation: "2026-08",
    publisher: "Publisher",
  };

  it("reports a missing observation with the feed's coverage, as a warning", () => {
    const v = security(
      [
        lot({
          valuation: {
            missing: [missingObservation],
            valuationComplete: false,
          },
        }),
      ],
      {
        benchmarkCoverage: [
          {
            benchmarkId: "BENCH_A",
            coveredThrough: "2026-07-01",
            lastFetchedAt: "2026-10-12T05:00:00.000Z",
          },
          { benchmarkId: "BENCH_B", coveredThrough: null, lastFetchedAt: null },
        ],
      },
    );
    const input = missingDataNotification(v) as NonNullable<
      ReturnType<typeof missingDataNotification>
    >;
    expect(input.type).toBe(NotificationType.BOND_DATA_MISSING);
    expect(input.severity).toBe(NotificationSeverity.WARNING);
    expect(input.data).toMatchObject({
      securityId: SECURITY,
      accountId: ACCOUNT_A,
      instrumentId: SERIES_1,
      causes: [{ code: "OBSERVATION_MISSING", ...missingObservation }],
      coverage: [{ benchmarkId: "BENCH_A", coveredThrough: "2026-07-01" }],
    });
  });

  it("reports incomplete terms, a purchase outside the sale window and underivable lots", () => {
    const terms = security([
      lot({
        valuation: {
          dataCompleteness: {
            termsComplete: false,
            referenceDataComplete: true,
            earlyRedemptionTermsComplete: true,
          },
        },
      }),
    ]);
    expect(missingCausesOf(terms).causes).toEqual([
      {
        code: "TERMS_INCOMPLETE",
        instrumentId: SERIES_1,
        seriesCode: "SER0001",
      },
    ]);
    const refused = security([
      lot({
        valuation: {
          status: "REFUSED",
          currentPeriod: null,
          refusal: {
            code: "PURCHASE_OUTSIDE_SALE_WINDOW",
            params: {
              from: "2025-01-01",
              to: "2025-01-31",
              purchaseDate: "2025-03-01",
            },
          },
        },
      }),
    ]);
    expect(missingCausesOf(refused).causes).toEqual([
      {
        code: "PURCHASE_OUTSIDE_SALE_WINDOW",
        instrumentId: SERIES_1,
        seriesCode: "SER0001",
        purchaseDate: "2025-03-01",
        from: "2025-01-01",
        to: "2025-01-31",
      },
    ]);
    const afterMaturity = security([
      lot({
        valuation: {
          status: "REFUSED",
          currentPeriod: null,
          refusal: {
            code: "PURCHASE_AFTER_MATURITY",
            params: { maturityDate: "2025-04-01", purchaseDate: "2025-04-02" },
          },
        },
      }),
    ]);
    expect(missingCausesOf(afterMaturity).causes).toEqual([
      {
        code: "PURCHASE_AFTER_MATURITY",
        instrumentId: SERIES_1,
        seriesCode: "SER0001",
        purchaseDate: "2025-04-02",
        maturityDate: "2025-04-01",
      },
    ]);
    expect(missingDataNotification(afterMaturity)?.message).toContain(
      "is on or after its maturity 2025-04-01; correct the purchase date",
    );
    // A refusal code the producer does not know is never reported as another
    // code's cause (a two-way ternary read it as PURCHASE_AFTER_MATURITY).
    const unknownRefusal = security([
      lot({
        valuation: {
          status: "REFUSED",
          currentPeriod: null,
          refusal: { code: "NOT_A_CODE", params: {} } as never,
        },
      }),
    ]);
    expect(() => missingCausesOf(unknownRefusal)).toThrow();
    const underivable = security([], {
      refusal: {
        code: "OVER_REMOVAL",
        params: { action: "SELL", date: "2026-01-01", quantity: "5" },
        detail: "over removal",
      },
    });
    expect(missingDataNotification(underivable)?.data?.causes).toEqual([
      {
        code: "LOTS_UNDERIVABLE",
        refusalCode: "OVER_REMOVAL",
        action: "SELL",
        date: "2026-01-01",
        quantity: "5",
      },
    ]);
  });

  it("names the refused row of underivable lots and keys the gap by it, not by its quantity", () => {
    const refused = (
      over: Partial<{ rowId: string; date: string; quantity: string }> = {},
    ) =>
      missingDataNotification(
        security([], {
          refusal: {
            code: "SERIES_NOT_DETERMINED",
            rowId: over.rowId ?? "row-1",
            params: {
              action: "BUY",
              date: over.date ?? "2026-01-01",
              quantity: over.quantity ?? "5",
            },
            detail: "no series",
          },
        }),
      ) as NonNullable<ReturnType<typeof missingDataNotification>>;
    const first = refused();
    expect(first.data?.causes).toEqual([
      {
        code: "LOTS_UNDERIVABLE",
        refusalCode: "SERIES_NOT_DETERMINED",
        action: "BUY",
        date: "2026-01-01",
        quantity: "5",
        rowId: "row-1",
      },
    ]);
    expect(refused({ quantity: "6" }).dedupeKey).toBe(first.dedupeKey);
    expect(refused({ rowId: "row-2" }).dedupeKey).not.toBe(first.dedupeKey);
    expect(refused({ date: "2026-01-02" }).dedupeKey).not.toBe(first.dedupeKey);
    expect(first.message).toContain("choose the series on that transaction");
  });

  it("raises nothing for a complete valuation or for a matured lot", () => {
    expect(missingDataNotification(security([lot()]))).toBeNull();
    const matured = security([
      lot({ valuation: { status: "MATURED", missing: [missingObservation] } }),
    ]);
    expect(missingDataNotification(matured)).toBeNull();
  });

  it("de-duplicates and sorts the causes of many lots", () => {
    const v = security([
      lot({ valuation: { missing: [missingObservation] } }),
      lot({ valuation: { missing: [missingObservation] } }),
    ]);
    expect(missingCausesOf(v).causes).toHaveLength(1);
  });

  it("keeps the key for the same gap and changes it for a different one", () => {
    const gap = (observation: string, fetched: string) =>
      missingDataNotification(
        security(
          [
            lot({
              valuation: { missing: [{ ...missingObservation, observation }] },
            }),
          ],
          {
            benchmarkCoverage: [
              {
                benchmarkId: "BENCH_A",
                coveredThrough: null,
                lastFetchedAt: fetched,
              },
            ],
          },
        ),
      ) as NonNullable<ReturnType<typeof missingDataNotification>>;
    const first = gap("2026-08", "2026-10-12T05:00:00.000Z");
    // Another fetch day is the same gap: one row, not one per day.
    expect(gap("2026-08", "2026-10-13T05:00:00.000Z").dedupeKey).toBe(
      first.dedupeKey,
    );
    expect(gap("2026-09", "2026-10-12T05:00:00.000Z").dedupeKey).not.toBe(
      first.dedupeKey,
    );
    expect(first.dedupeKey).toMatch(
      new RegExp(`^bond:missing:${SECURITY}:[0-9a-f]{16}$`),
    );
  });
});

describe("dedupe keys", () => {
  it("are distinct for another account, series or date", () => {
    const keys = [
      bondDedupeKeys.maturity(ACCOUNT_A, SERIES_1, "2026-10-25"),
      bondDedupeKeys.maturity(ACCOUNT_B, SERIES_1, "2026-10-25"),
      bondDedupeKeys.maturity(ACCOUNT_A, SERIES_2, "2026-10-25"),
      bondDedupeKeys.maturity(ACCOUNT_A, SERIES_1, "2026-10-26"),
      bondDedupeKeys.interest(ACCOUNT_A, SERIES_1, "2026-10-25"),
      bondDedupeKeys.rate(ACCOUNT_A, SERIES_1, "2026-10-25"),
      bondDedupeKeys.unbooked(ACCOUNT_A, SERIES_1, "2026-10-25"),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("fit the dedupe_key column", () => {
    const longest = [
      bondDedupeKeys.maturity(ACCOUNT_A, SERIES_1, "2026-10-25"),
      bondDedupeKeys.unbooked(ACCOUNT_A, SERIES_1, "2026-10-25"),
      bondDedupeKeys.benchmark("B".repeat(40), "2026-10-25"),
      bondDedupeKeys.missing(SECURITY, []),
    ];
    for (const key of longest) {
      expect(key.length).toBeLessThanOrEqual(DEDUPE_KEY_MAX_LENGTH);
    }
  });
});

describe("payout", () => {
  it("is the engine's split, with its refusal carried and the figures nulled", () => {
    expect(payoutOf(knownSplit)).toEqual({
      payout: "4123.45",
      interest: "123.45",
      principalReturned: "4000.00",
      missing: null,
    });
    expect(
      payoutOf({ ...knownSplit, refusal: "TERMS_INCOMPLETE", payout: "1.00" }),
    ).toEqual({
      payout: null,
      interest: null,
      principalReturned: null,
      missing: "TERMS_INCOMPLETE",
    });
  });
});
