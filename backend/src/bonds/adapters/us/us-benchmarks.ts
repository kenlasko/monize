import { BenchmarkSeriesDefinition } from "../../bond-adapter";
import { BLS_CPI_LANDING_URL, BLS_HOST } from "./us-bls-cpi";
import { TBILL_13W_SOURCE_URL } from "./us-tbill-13w";
import { TREASURY_HOST } from "./series/series-source";

export const US_CPI_U_NSA = "US_CPI_U_NSA";
export const US_TBILL_13W_MMY = "US_TBILL_13W_MMY";

/** The two series the TIPS and the floating rate notes reference (country spec section 6). */
export const usBenchmarks: readonly BenchmarkSeriesDefinition[] = [
  {
    code: US_CPI_U_NSA,
    kind: "MONTHLY",
    publisher: "BLS",
    sourceUrl: BLS_CPI_LANDING_URL,
    hosts: [BLS_HOST],
    unit: "INDEX_LEVEL",
    providerId: "bls",
  },
  {
    code: US_TBILL_13W_MMY,
    kind: "STEP",
    publisher: "Treasury",
    sourceUrl: TBILL_13W_SOURCE_URL,
    hosts: [TREASURY_HOST],
    unit: "RATE_FRACTION",
    providerId: "treasurydirect",
  },
];
