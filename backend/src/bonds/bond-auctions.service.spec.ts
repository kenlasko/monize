import { HttpException, NotFoundException } from "@nestjs/common";
import { DataSource } from "typeorm";
import { createScopedDbMocks } from "../test-helpers/scoped-db-testing";
import { AuthAttemptCounterService } from "../auth/auth-attempt-counter.service";
import { AuctionListing, BondAdapter } from "./bond-adapter";
import { BondAuctionsService } from "./bond-auctions.service";
import { SERIES_FETCH_LIMIT } from "./series-fetch-allowance";
import { SeriesHttp } from "./series-http";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const SEC = "sec-1";
const PROGRAM = "prog-1";
const STORED = "33333333-3333-5333-8333-333333333333";

const listing = (over: Partial<AuctionListing>): AuctionListing => ({
  seriesCode: "91282CRT0",
  identifier: "91282CRT0",
  term: "5-Year",
  auctionDate: "2026-10-27",
  issueDate: "2026-11-02",
  maturityDate: "2031-10-31",
  reopening: false,
  announced: false,
  rateKind: "COUPON",
  ratePercent: "4.75",
  pricePer100: "99.582397",
  ...over,
});

function setup(
  opts: {
    linked?: boolean;
    country?: string;
    adapter?: Partial<BondAdapter>;
    attempts?: number;
  } = {},
) {
  const { manager, dataSource } = createScopedDbMocks();
  manager.query.mockImplementation(
    async (sql: string, params: unknown[] = []) => {
      if (sql.includes("bond_auto_fetch")) {
        return params[1] === USER && opts.linked !== false
          ? [
              {
                id: SEC,
                user_id: USER,
                symbol: "UST",
                currency_code: "USD",
                bond_program_id: PROGRAM,
                bond_auto_fetch: false,
              },
            ]
          : [];
      }
      if (sql.includes("FROM bond_programs WHERE id")) {
        return [
          {
            id: PROGRAM,
            issuer_country_code: opts.country ?? "US",
            program_code: "NOTE",
          },
        ];
      }
      if (sql.includes("FROM bond_instruments")) {
        const codes = params[1] as string[];
        return codes.includes("91282CRT0")
          ? [{ id: STORED, series_code: "91282CRT0" }]
          : [];
      }
      return [];
    },
  );
  const auctionsNear = jest.fn().mockResolvedValue([
    listing({}),
    listing({
      seriesCode: "91282CRW3",
      identifier: "91282CRW3",
      announced: true,
      ratePercent: null,
      pricePer100: null,
    }),
  ]);
  const adapter = {
    countryCode: "US",
    seriesProviderId: "treasurydirect",
    auctionsNear,
    ...opts.adapter,
  } as unknown as BondAdapter;
  const gatedFetch = jest.fn();
  const http = { gated: jest.fn().mockReturnValue(gatedFetch) };
  const attempts = {
    increment: jest.fn().mockResolvedValue({ count: opts.attempts ?? 1 }),
  };
  const service = new BondAuctionsService(
    dataSource as unknown as DataSource,
    http as unknown as SeriesHttp,
    attempts as unknown as AuthAttemptCounterService,
  );
  const run = () =>
    service.auctionsFor(USER, SEC, "2026-11-06", { adapters: [adapter] });
  return { run, auctionsNear, http, gatedFetch, attempts };
}

describe("BondAuctionsService.auctionsFor", () => {
  it("lists the program's auctions through the gated fetch, marking the stored series", async () => {
    const { run, auctionsNear, http, gatedFetch } = setup();
    const result = await run();
    expect(http.gated).toHaveBeenCalledWith("treasurydirect", undefined);
    expect(auctionsNear).toHaveBeenCalledWith("NOTE", "2026-11-06", gatedFetch);
    expect(result.countryCode).toBe("US");
    expect(result.supported).toBe(true);
    expect(result.auctions.map((a) => [a.seriesCode, a.instrumentId])).toEqual([
      ["91282CRT0", STORED],
      ["91282CRW3", null],
    ]);
  });

  it("charges the series fetch allowance before asking the issuer", async () => {
    const { run, attempts, auctionsNear } = setup({
      attempts: SERIES_FETCH_LIMIT + 1,
    });
    await expect(run()).rejects.toBeInstanceOf(HttpException);
    expect(attempts.increment).toHaveBeenCalledTimes(1);
    expect(auctionsNear).not.toHaveBeenCalled();
  });

  it("answers unsupported, with no request and no charge, for a country without auction listings", async () => {
    const { run, attempts, http } = setup({
      country: "PL",
      adapter: { countryCode: "PL", auctionsNear: undefined },
    });
    await expect(run()).resolves.toEqual({
      countryCode: "PL",
      supported: false,
      auctions: [],
    });
    expect(attempts.increment).not.toHaveBeenCalled();
    expect(http.gated).not.toHaveBeenCalled();
  });

  it("is a 404 for a security that is not the caller's or not linked", async () => {
    const { run, auctionsNear } = setup({ linked: false });
    await expect(run()).rejects.toBeInstanceOf(NotFoundException);
    expect(auctionsNear).not.toHaveBeenCalled();
  });
});
