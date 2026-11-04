import bill from "../templates/bill.template.json";
import bond from "../templates/bond.template.json";
import note from "../templates/note.template.json";

type Json = Record<string, unknown>;

export type UsProgram = "BILL" | "NOTE" | "BOND";

/**
 * One product's structure with everything per-series left out: the dates, the
 * rate or the price, the source (`no-automatic-bonds.guard.spec.ts` lists the
 * keys a template may never hold). The series fetch fills the rest.
 */
export interface SeriesTemplate {
  readonly product: UsProgram;
  /** The product page of the issuer, the program's `infoUrl`. */
  readonly infoUrl: string;
  readonly structure: {
    readonly instrument: Json;
    readonly schedule: Json;
    readonly rateRule: Json;
    readonly rest: Json;
  };
}

export const SERIES_TEMPLATES: Readonly<Record<UsProgram, SeriesTemplate>> = {
  BILL: bill as SeriesTemplate,
  NOTE: note as SeriesTemplate,
  BOND: bond as SeriesTemplate,
};

export interface SourceDocument {
  readonly provider: string;
  readonly url: string;
  readonly document: string;
}

/** What a bill adds to its template. */
export interface BillValues {
  readonly seriesCode: string;
  readonly issueDate: string;
  readonly maturityDate: string;
  /** The auction price per 100 of face, an exact decimal string. */
  readonly issuePrice: string;
  readonly source: SourceDocument;
}

/** What a note or a bond adds to its template. */
export interface CouponValues {
  readonly seriesCode: string;
  readonly datedDate: string;
  readonly firstCouponDate: string;
  readonly maturityDate: string;
  /** True when the maturity is the last day of its month: coupons fall on month ends. */
  readonly endOfMonth: boolean;
  /** The coupon rate as a fraction, an exact decimal string ("0.04125"). */
  readonly annualRate: string;
  readonly source: SourceDocument;
}

/** The bill template filled: the terms document, before `parseBondTerms`. */
export function fillBill(t: SeriesTemplate, v: BillValues): unknown {
  const s = t.structure;
  return {
    ...s.rest,
    instrument: {
      ...s.instrument,
      seriesCode: v.seriesCode,
      issuePrice: v.issuePrice,
    },
    saleWindow: null,
    schedule: {
      ...s.schedule,
      issueDate: v.issueDate,
      maturityDate: v.maturityDate,
    },
    rateRule: { ...s.rateRule },
    source: { ...v.source },
  };
}

/** The note or bond template filled: the terms document, before `parseBondTerms`. */
export function fillCoupon(t: SeriesTemplate, v: CouponValues): unknown {
  const s = t.structure;
  return {
    ...s.rest,
    instrument: { ...s.instrument, seriesCode: v.seriesCode },
    saleWindow: null,
    schedule: {
      ...s.schedule,
      datedDate: v.datedDate,
      firstCouponDate: v.firstCouponDate,
      maturityDate: v.maturityDate,
      endOfMonth: v.endOfMonth,
    },
    rateRule: { ...s.rateRule, annualRate: v.annualRate },
    source: { ...v.source },
  };
}
