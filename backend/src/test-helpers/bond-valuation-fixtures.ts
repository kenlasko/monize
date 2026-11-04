import {
  SecurityLotValuation,
  SecurityValuation,
} from "../bonds/bond-valuation.service";
import { BondValuation, CashFlow } from "../bonds/engine/bond-engine";

/**
 * Typed builders of the engine's valuation for the bond notification specs: a
 * complete open lot at a fixed rate that a test overrides where it is about
 * something, so `tsc` rejects a shape the engine cannot produce.
 */

export const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
export const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
export const SERIES_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const SERIES_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const SECURITY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const TODAY = "2026-10-13";

/** A complete engine valuation of an open lot; a test overrides what it is about. */
export function valuation(over: Partial<BondValuation> = {}): BondValuation {
  return {
    asOf: TODAY,
    seriesCode: "SER0001",
    termsVersion: 1,
    quantity: 10,
    maturityDate: "2027-10-13",
    status: "OPEN",
    refusal: null,
    currentPeriod: {
      index: 1,
      start: "2025-10-13",
      end: "2026-10-13",
      annualRate: "0.05",
      rateSource: "TERMS",
    },
    rateRule: {
      type: "FIXED",
      benchmarkId: null,
      annualRate: "0.05",
      firstPeriodRate: null,
      addend: null,
      benchmarkFloor: null,
    },
    rateSchedule: [],
    principal: "100.00",
    accruedInterest: "0.00",
    grossValue: "1000.00",
    earlyRedemptionValue: null,
    earlyRedemptionRefusal: null,
    nextPayment: [],
    nextRateReset: null,
    nextCapitalization: null,
    knownCashflows: [],
    projectedCashflows: [],
    maturityValueKnown: null,
    maturityValueProjected: null,
    projectionAssumptions: [],
    projectionMissing: [],
    dataCompleteness: {
      termsComplete: true,
      referenceDataComplete: true,
      earlyRedemptionTermsComplete: true,
    },
    missing: [],
    valuationComplete: true,
    ...over,
  };
}

export function lot(
  over: Partial<Omit<SecurityLotValuation, "valuation">> & {
    valuation?: Partial<BondValuation>;
  } = {},
): SecurityLotValuation {
  const { valuation: v, ...rest } = over;
  return {
    instrumentId: SERIES_1,
    accountId: ACCOUNT_A,
    purchaseDate: "2025-10-13",
    quantity: 10,
    purchaseDateAssumed: false,
    valuation: valuation({ quantity: rest.quantity ?? 10, ...v }),
    ...rest,
  };
}

export function security(
  lots: SecurityLotValuation[],
  over: Partial<SecurityValuation> = {},
): SecurityValuation {
  return {
    securityId: SECURITY,
    program: {
      id: "program-1",
      programCode: "PRG",
      issuerCountryCode: "XX",
      issuerCode: "ISS",
      currency: "EUR",
    },
    autoFetch: false,
    asOf: TODAY,
    lots,
    series: [],
    benchmarkCoverage: [],
    totals: {
      quantity: null,
      grossValue: null,
      earlyRedemptionValue: null,
      accruedInterest: null,
    },
    refusal: null,
    marketPriceRequired: false,
    ...over,
  };
}

export function flow(over: Partial<CashFlow> = {}): CashFlow {
  return {
    date: TODAY,
    type: "INTEREST",
    amount: "51.00",
    status: "KNOWN",
    period: 2,
    ...over,
  };
}
