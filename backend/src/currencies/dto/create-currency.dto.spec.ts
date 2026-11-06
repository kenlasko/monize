import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { CreateCurrencyDto } from "./create-currency.dto";

function buildDto(
  overrides: Partial<CreateCurrencyDto> = {},
): CreateCurrencyDto {
  const dto = new CreateCurrencyDto();
  dto.code = "CAD";
  dto.name = "Canadian Dollar";
  dto.symbol = "CA$";
  Object.assign(dto, overrides);
  return dto;
}

describe("CreateCurrencyDto", () => {
  it("passes validation with all required fields", async () => {
    const dto = buildDto();
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("passes validation with all fields provided", async () => {
    const dto = buildDto({
      decimalPlaces: 0,
      isActive: true,
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // ── code ────────────────────────────────────────────────────

  it("rejects code shorter than 3 characters", async () => {
    const dto = buildDto({ code: "CA" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("code");
    expect(errors[0].constraints).toHaveProperty("matches");
  });

  it("rejects code longer than 3 characters", async () => {
    const dto = buildDto({ code: "CADD" });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("code");
  });

  it("rejects a code that is not three letters", async () => {
    const dto = plainToInstance(CreateCurrencyDto, {
      code: "q#!",
      name: "Junk",
      symbol: "?",
    });
    const errors = await validate(dto);
    expect(errors.map((e) => e.property)).toEqual(["code"]);
  });

  it("accepts a lower-case code and upper-cases it", async () => {
    const dto = plainToInstance(CreateCurrencyDto, {
      code: "pln",
      name: "Zloty",
      symbol: "zl",
    });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.code).toBe("PLN");
  });

  it("rejects missing code", async () => {
    const dto = buildDto();
    delete (dto as any).code;
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("code");
  });

  it("rejects non-string code", async () => {
    const dto = buildDto({ code: 123 as any });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("code");
  });

  // ── name ────────────────────────────────────────────────────

  it("rejects missing name", async () => {
    const dto = buildDto();
    delete (dto as any).name;
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("name");
  });

  it("rejects name exceeding 100 characters", async () => {
    const dto = buildDto({ name: "x".repeat(101) });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("name");
  });

  // ── symbol ──────────────────────────────────────────────────

  it("rejects missing symbol", async () => {
    const dto = buildDto();
    delete (dto as any).symbol;
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("symbol");
  });

  it("rejects symbol exceeding 10 characters", async () => {
    const dto = buildDto({ symbol: "x".repeat(11) });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("symbol");
  });

  // ── decimalPlaces (optional) ────────────────────────────────

  it("accepts decimalPlaces of 0", async () => {
    const dto = buildDto({ decimalPlaces: 0 });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts decimalPlaces of 4", async () => {
    const dto = buildDto({ decimalPlaces: 4 });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects decimalPlaces below 0", async () => {
    const dto = buildDto({ decimalPlaces: -1 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("decimalPlaces");
  });

  it("accepts decimalPlaces of 8, the most money holds", async () => {
    const dto = buildDto({ decimalPlaces: 8 });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects decimalPlaces above 8", async () => {
    const dto = buildDto({ decimalPlaces: 9 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("decimalPlaces");
  });

  it("rejects non-integer decimalPlaces", async () => {
    const dto = buildDto({ decimalPlaces: 2.5 });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("decimalPlaces");
  });

  it("allows decimalPlaces to be omitted", async () => {
    const dto = buildDto();
    delete dto.decimalPlaces;
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  // ── isActive (optional) ─────────────────────────────────────

  it("allows isActive to be omitted", async () => {
    const dto = buildDto();
    delete dto.isActive;
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("accepts boolean isActive", async () => {
    const dto = buildDto({ isActive: false });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it("rejects non-boolean isActive", async () => {
    const dto = buildDto({ isActive: "yes" as any });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].property).toBe("isActive");
  });

  // ── kind and quoteSymbol (optional) ─────────────────────────

  const fromBody = (body: Record<string, unknown>) =>
    plainToInstance(CreateCurrencyDto, {
      code: "BTC",
      name: "Bitcoin",
      symbol: "B",
      ...body,
    });

  it("accepts the two kinds and leaves the kind out when omitted", async () => {
    for (const kind of ["FIAT", "CRYPTO"]) {
      expect(await validate(fromBody({ kind }))).toHaveLength(0);
    }
    const omitted = fromBody({});
    expect(await validate(omitted)).toHaveLength(0);
    expect(omitted.kind).toBeUndefined();
  });

  it.each(["crypto", "STOCK", "", 1])("rejects the kind %p", async (kind) => {
    const errors = await validate(fromBody({ kind }));
    expect(errors.map((e) => e.property)).toEqual(["kind"]);
    expect(errors[0].constraints).toHaveProperty("isIn");
  });

  it("upper-cases and trims a price symbol", async () => {
    const dto = fromBody({ kind: "CRYPTO", quoteSymbol: "  btc-eur " });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.quoteSymbol).toBe("BTC-EUR");
  });

  it("reads a blank price symbol as none, and accepts null", async () => {
    const blank = fromBody({ kind: "CRYPTO", quoteSymbol: "   " });
    expect(await validate(blank)).toHaveLength(0);
    expect(blank.quoteSymbol).toBeNull();
    const cleared = fromBody({ kind: "CRYPTO", quoteSymbol: null });
    expect(await validate(cleared)).toHaveLength(0);
    expect(cleared.quoteSymbol).toBeNull();
  });

  it("rejects a price symbol longer than 20 characters", async () => {
    const errors = await validate(
      fromBody({ kind: "CRYPTO", quoteSymbol: `${"A".repeat(17)}-EUR` }),
    );
    expect(errors.map((e) => e.property)).toEqual(["quoteSymbol"]);
    expect(errors[0].constraints).toHaveProperty("maxLength");
  });

  it.each(["BTC EUR", "BTC/EUR", "<b>BTC-EUR", "BTC_EUR"])(
    "rejects the price symbol %p, which no Yahoo ticker is spelled with",
    async (quoteSymbol) => {
      const errors = await validate(fromBody({ kind: "CRYPTO", quoteSymbol }));
      expect(errors.map((e) => e.property)).toEqual(["quoteSymbol"]);
    },
  );

  it("rejects a non-string price symbol", async () => {
    const errors = await validate(fromBody({ kind: "CRYPTO", quoteSymbol: 7 }));
    expect(errors.map((e) => e.property)).toEqual(["quoteSymbol"]);
  });

  it("leaves the kind rules to the service: a well-formed symbol passes the DTO on its own", async () => {
    // An update that omits `kind` keeps the row's, so only the service can
    // decide whether the symbol belongs (`quoteSymbolRequiresCrypto`) or names
    // a fiat leg (`quoteSymbolNotAPair`).
    expect(await validate(fromBody({ quoteSymbol: "BTC" }))).toHaveLength(0);
  });

  it("accepts a coin at eight places and refuses decimal places past what money holds", async () => {
    expect(
      await validate(
        fromBody({ kind: "CRYPTO", quoteSymbol: "BTC-EUR", decimalPlaces: 8 }),
      ),
    ).toHaveLength(0);
    const errors = await validate(
      fromBody({ kind: "CRYPTO", quoteSymbol: "BTC-EUR", decimalPlaces: 9 }),
    );
    expect(errors.map((e) => e.property)).toEqual(["decimalPlaces"]);
  });
});
