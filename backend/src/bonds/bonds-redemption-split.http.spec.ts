import { INestApplication } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createGlobalValidationPipe } from "../common/pipes/global-validation.pipe";
import { BondAuctionsService } from "./bond-auctions.service";
import { BondCatalogService } from "./bond-catalog.service";
import { BondHoldingsService } from "./bond-holdings.service";
import { BondOfferService } from "./bond-offer.service";
import { BondPriceService } from "./bond-price.service";
import { BondSeriesService } from "./bond-series.service";
import { BondValuationService } from "./bond-valuation.service";
import { BondsController } from "./bonds.controller";

const USER = "11111111-1111-4111-8111-111111111111";
const SECURITY = "22222222-2222-4222-8222-222222222222";
const INSTRUMENT = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = "44444444-4444-4444-8444-444444444444";
const PATH = `/bonds/securities/${SECURITY}/redemption-split`;

/**
 * The redemption-split route through the real request pipeline: the global
 * `ValidationPipe` runs before the parameter pipes, and with `transform: true`
 * it converts a query parameter by its declared type first. Calling the
 * controller method directly skips that step, which is how every quantity came
 * to be refused with a 400 (issue 2221). A spelling `+value` would read as a
 * whole number (`0x10` as 16, `2.9999999999999999` as 3) is refused, not
 * answered for a quantity nobody typed.
 */
describe("GET /bonds/securities/:id/redemption-split over HTTP", () => {
  let app: INestApplication;
  const holdings = { redemptionSplit: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BondsController],
      providers: [
        { provide: BondSeriesService, useValue: {} },
        { provide: BondCatalogService, useValue: {} },
        { provide: BondValuationService, useValue: {} },
        { provide: BondPriceService, useValue: {} },
        { provide: BondOfferService, useValue: {} },
        { provide: BondHoldingsService, useValue: holdings },
        { provide: BondAuctionsService, useValue: {} },
      ],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleRef.createNestApplication();
    app.use(
      (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
        req.user = { id: USER };
        next();
      },
    );
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    holdings.redemptionSplit.mockReset();
  });

  const query = (quantity: string | string[]) => ({
    date: "2024-08-08",
    quantity,
    bondInstrumentId: INSTRUMENT,
    accountId: ACCOUNT,
  });

  it.each([
    ["3910", 3910],
    ["10", 10],
    ["1", 1],
    ["1000000000", 1_000_000_000],
  ])(
    "hands quantity=%s to the service as the number %d",
    async (raw, expected) => {
      const body = { date: "2024-08-08", quantity: expected };
      holdings.redemptionSplit.mockResolvedValue(body);
      const res = await request(app.getHttpServer())
        .get(PATH)
        .query(query(raw))
        .expect(200);
      expect(res.body).toEqual(body);
      expect(holdings.redemptionSplit).toHaveBeenCalledWith(
        USER,
        SECURITY,
        ACCOUNT,
        INSTRUMENT,
        "2024-08-08",
        expected,
        undefined,
      );
    },
  );

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["not a number", "abc"],
    ["over the bound", "1000000001"],
    ["in exponent form", "1e3"],
    ["hexadecimal", "0x10"],
    ["written with a grouping point", "1.000"],
    ["a fraction past double precision", "2.9999999999999999"],
    ["padded", " 5"],
    ["zero-led", "007"],
    ["repeated", ["4", "5"]],
  ])(
    "refuses a quantity that is %s with a 400 before the service runs",
    async (_label, raw) => {
      const params = query(raw ?? "");
      const sent =
        raw === undefined ? { ...params, quantity: undefined } : params;
      const res = await request(app.getHttpServer())
        .get(PATH)
        .query(sent)
        .expect(400);
      expect(res.body.message).toMatch(/positive whole number of bonds/);
      expect(res.body.errorCode).toBe("QUANTITY_INVALID");
      expect(holdings.redemptionSplit).not.toHaveBeenCalled();
    },
  );

  it("names the text it refused, not an empty value", async () => {
    const res = await request(app.getHttpServer())
      .get(PATH)
      .query(query("0x10"))
      .expect(400);
    expect(res.body.message).toMatch(/bonds: 0x10$/);
  });
});
