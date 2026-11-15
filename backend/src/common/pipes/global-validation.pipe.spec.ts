import {
  Controller,
  DefaultValuePipe,
  Get,
  INestApplication,
  Param,
  ParseBoolPipe,
  ParseFloatPipe,
  ParseIntPipe,
  Query,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { createGlobalValidationPipe } from "./global-validation.pipe";

@Controller("probe")
class ProbeController {
  @Get("limit")
  limit(
    @Query("limit", new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ): { limit: number } {
    return { limit };
  }

  @Get("days")
  days(@Query("days", new ParseIntPipe({ optional: true })) days?: number): {
    days: number | null;
  } {
    return { days: days ?? null };
  }

  @Get("threshold")
  threshold(
    @Query("threshold", new DefaultValuePipe(0.85), ParseFloatPipe)
    threshold: number,
  ): { threshold: number } {
    return { threshold };
  }

  @Get("inactive")
  inactive(
    @Query("includeInactive", new DefaultValuePipe(false), ParseBoolPipe)
    includeInactive: boolean,
  ): { includeInactive: boolean } {
    return { includeInactive };
  }

  @Get("unread")
  unread(
    @Query("unreadOnly", new ParseBoolPipe({ optional: true }))
    unreadOnly?: boolean,
  ): { unreadOnly: boolean | null } {
    return { unreadOnly: unreadOnly ?? null };
  }

  @Get("price/:priceId")
  price(@Param("priceId", ParseIntPipe) priceId: number): { priceId: number } {
    return { priceId };
  }

  @Get("text")
  text(@Query("q") q: string): { q: unknown } {
    return { q };
  }
}

/**
 * A `number` or `boolean` query or route parameter through the real request
 * pipeline: the global pipe hands its Nest pipe the request's text, so a
 * spelling `+value` or `value === "true"` would have read as something else is
 * refused with a 400, and an empty value is the default (issue 2225).
 */
describe("createGlobalValidationPipe over HTTP", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (path: string) => request(app.getHttpServer()).get(path);

  describe("an integer behind ParseIntPipe", () => {
    it.each([
      ["16", 16],
      ["0", 0],
      ["-3", -3],
    ])("answers limit=%s as %d", async (raw, expected) => {
      const res = await get(`/probe/limit?limit=${raw}`).expect(200);
      expect(res.body).toEqual({ limit: expected });
    });

    it.each([
      ["absent", "/probe/limit"],
      ["empty", "/probe/limit?limit="],
    ])("takes the default when the value is %s", async (_label, path) => {
      const res = await get(path).expect(200);
      expect(res.body).toEqual({ limit: 10 });
    });

    it.each([
      "0x10",
      "1e3",
      "1.5",
      "2.9999999999999999",
      "abc",
      "%2016",
      "Infinity",
    ])("refuses limit=%s with a 400", async (raw) => {
      await get(`/probe/limit?limit=${raw}`).expect(400);
    });

    it("refuses a repeated key with a 400", async () => {
      await get("/probe/limit?limit=1&limit=2").expect(400);
    });

    it("leaves an optional integer absent when it is absent or empty", async () => {
      expect((await get("/probe/days").expect(200)).body).toEqual({
        days: null,
      });
      expect((await get("/probe/days?days=").expect(200)).body).toEqual({
        days: null,
      });
      expect((await get("/probe/days?days=45").expect(200)).body).toEqual({
        days: 45,
      });
      await get("/probe/days?days=0x2d").expect(400);
    });

    it("checks a route parameter's text the same way", async () => {
      expect((await get("/probe/price/42").expect(200)).body).toEqual({
        priceId: 42,
      });
      await get("/probe/price/0x2a").expect(400);
      await get("/probe/price/4.2").expect(400);
    });
  });

  describe("a decimal behind ParseFloatPipe", () => {
    it("answers a decimal and takes the default when empty", async () => {
      expect(
        (await get("/probe/threshold?threshold=0.7").expect(200)).body,
      ).toEqual({ threshold: 0.7 });
      expect(
        (await get("/probe/threshold?threshold=").expect(200)).body,
      ).toEqual({ threshold: 0.85 });
    });

    it.each(["0x1", "abc", "%200.7", "Infinity"])(
      "refuses threshold=%s with a 400",
      async (raw) => {
        await get(`/probe/threshold?threshold=${raw}`).expect(400);
      },
    );
  });

  describe("a boolean behind ParseBoolPipe", () => {
    it.each([
      ["true", true],
      ["false", false],
    ])("answers includeInactive=%s as %s", async (raw, expected) => {
      const res = await get(`/probe/inactive?includeInactive=${raw}`).expect(
        200,
      );
      expect(res.body).toEqual({ includeInactive: expected });
    });

    it.each([
      ["absent", "/probe/inactive"],
      ["empty", "/probe/inactive?includeInactive="],
    ])("takes the default when the value is %s", async (_label, path) => {
      expect((await get(path).expect(200)).body).toEqual({
        includeInactive: false,
      });
    });

    it.each(["yes", "1", "0", "TRUE", "on"])(
      "refuses includeInactive=%s with a 400 rather than reading it as false",
      async (raw) => {
        await get(`/probe/inactive?includeInactive=${raw}`).expect(400);
      },
    );

    it("refuses a repeated key with a 400", async () => {
      await get(
        "/probe/inactive?includeInactive=true&includeInactive=true",
      ).expect(400);
    });

    it("leaves an optional boolean absent when it is absent or empty", async () => {
      expect((await get("/probe/unread").expect(200)).body).toEqual({
        unreadOnly: null,
      });
      expect((await get("/probe/unread?unreadOnly=").expect(200)).body).toEqual(
        { unreadOnly: null },
      );
      expect(
        (await get("/probe/unread?unreadOnly=true").expect(200)).body,
      ).toEqual({ unreadOnly: true });
      await get("/probe/unread?unreadOnly=yes").expect(400);
    });
  });

  it("still converts a string parameter to text, a repeated key joined", async () => {
    expect((await get("/probe/text?q=a&q=b").expect(200)).body).toEqual({
      q: "a,b",
    });
    expect((await get("/probe/text?q=").expect(200)).body).toEqual({ q: "" });
  });
});
