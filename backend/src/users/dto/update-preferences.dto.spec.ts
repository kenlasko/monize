import { validate } from "class-validator";
import { plainToInstance } from "class-transformer";
import { MAP_PROVIDERS, UpdatePreferencesDto } from "./update-preferences.dto";
import { UserPreference } from "../entities/user-preference.entity";

async function languageError(language: string) {
  const dto = plainToInstance(UpdatePreferencesDto, { language });
  const errors = await validate(dto);
  return errors.find((e) => e.property === "language");
}

describe("UpdatePreferencesDto language validation", () => {
  it.each(["browser", "en", "fr", "pt-BR", "en-US", "en-GB"])(
    "accepts %s",
    async (language) => {
      expect(await languageError(language)).toBeUndefined();
    },
  );

  it.each(["EN", "english", "browserx", "e", "en_US", "en-gb"])(
    "rejects %s",
    async (language) => {
      expect(await languageError(language)).toBeDefined();
    },
  );
});

async function lengthError(field: string, value: string) {
  const dto = plainToInstance(UpdatePreferencesDto, { [field]: value });
  const errors = await validate(dto);
  return errors.find((e) => e.property === field);
}

describe("UpdatePreferencesDto length caps match user_preferences columns", () => {
  // dateFormat/numberFormat are VARCHAR(20), timezone is VARCHAR(50)
  // (database/schema.sql): a value past the column's own width must be
  // refused here, not accepted and then truncated or rejected by Postgres.
  // numberFormat also carries @IsNumberLocale, so its boundary values are
  // syntactically valid BCP 47 tags (private-use subtags padding the
  // length), not an arbitrary "x" run that would fail for an unrelated
  // reason at every length.
  it.each([
    ["dateFormat", "x".repeat(20)],
    ["numberFormat", "en-US-x-aaaaaaaa-bbb"], // 20 chars
    ["timezone", "x".repeat(50)],
  ])("accepts %s at its length cap", async (field, value) => {
    expect(value).toHaveLength(field === "timezone" ? 50 : 20);
    expect(await lengthError(field, value)).toBeUndefined();
  });

  it.each([
    ["dateFormat", "x".repeat(21)],
    ["numberFormat", "en-US-x-aaaaaaaa-bbbb"], // 21 chars
    ["timezone", "x".repeat(51)],
  ])("rejects %s one character past its length cap", async (field, value) => {
    expect(value).toHaveLength(field === "timezone" ? 51 : 21);
    expect(await lengthError(field, value)).toBeDefined();
  });
});

async function aiBubbleError(aiBubbleEnabled: unknown) {
  const dto = plainToInstance(UpdatePreferencesDto, { aiBubbleEnabled });
  const errors = await validate(dto);
  return errors.find((e) => e.property === "aiBubbleEnabled");
}

describe("UpdatePreferencesDto aiBubbleEnabled validation", () => {
  it.each([true, false])("accepts %s", async (value) => {
    expect(await aiBubbleError(value)).toBeUndefined();
  });

  it("accepts an omitted value (optional)", async () => {
    const dto = plainToInstance(UpdatePreferencesDto, {});
    const errors = await validate(dto);
    expect(
      errors.find((e) => e.property === "aiBubbleEnabled"),
    ).toBeUndefined();
  });

  it.each(["yes", "true", 1, 0])("rejects %s", async (value) => {
    expect(await aiBubbleError(value)).toBeDefined();
  });
});

async function mapProviderError(defaultMapProvider: string) {
  const dto = plainToInstance(UpdatePreferencesDto, { defaultMapProvider });
  const errors = await validate(dto);
  return errors.find((e) => e.property === "defaultMapProvider");
}

describe("UpdatePreferencesDto map provider validation", () => {
  it.each([...MAP_PROVIDERS])("accepts %s", async (provider) => {
    expect(await mapProviderError(provider)).toBeUndefined();
  });

  it.each(["yandex", "Google", "", "openstreetmaps", "device "])(
    "rejects %s",
    async (provider) => {
      expect(await mapProviderError(provider)).toBeDefined();
    },
  );

  it("accepts an omitted provider, so an unrelated update need not send one", async () => {
    const dto = plainToInstance(UpdatePreferencesDto, {
      dateFormat: "YYYY-MM-DD",
    });
    const errors = await validate(dto);
    expect(
      errors.find((e) => e.property === "defaultMapProvider"),
    ).toBeUndefined();
  });

  it("lists exactly the values the entity column accepts", () => {
    // The entity writes its union out longhand so the varchar-capacity guard
    // can measure it, so the two lists are separate statements of one fact.
    // This is what stops them drifting -- and with them, the database CHECK.
    const fromEntity: UserPreference["defaultMapProvider"][] = [
      "device",
      "openstreetmap",
      "google",
      "apple",
      "bing",
      "waze",
    ];
    expect([...MAP_PROVIDERS].sort()).toEqual([...fromEntity].sort());
  });
});

describe("retired browser notification preference", () => {
  it.each([true, false])(
    "rejects the retired flag (%s) at the API boundary",
    async (value) => {
      const dto = plainToInstance(UpdatePreferencesDto, {
        notificationBrowser: value,
        notificationEmail: false,
      });
      const errors = await validate(dto, {
        whitelist: true,
        forbidNonWhitelisted: true,
      });
      expect(errors).toHaveLength(1);
      expect(errors[0].property).toBe("notificationBrowser");
      expect(errors[0].constraints).toHaveProperty("whitelistValidation");
    },
  );
});

async function hiddenColumnsErrors(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdatePreferencesDto, payload);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe("UpdatePreferencesDto hiddenTableColumns validation", () => {
  it.each<[string, Record<string, unknown>]>([
    ["omitted", {}],
    ["an empty map", { hiddenTableColumns: {} }],
    [
      "transactions with its full list",
      {
        hiddenTableColumns: {
          transactions: [
            "description",
            "refNumber",
            "tags",
            "attachments",
            "status",
          ],
        },
      },
    ],
    [
      "investmentHoldings with its full list",
      {
        hiddenTableColumns: {
          investmentHoldings: [
            "shares",
            "avgCost",
            "price",
            "costBasis",
            "mktValue",
            "gainLoss",
            "portfolioPercent",
          ],
        },
      },
    ],
    [
      "investmentRegister with its full list",
      {
        hiddenTableColumns: {
          investmentRegister: ["shares", "price", "status"],
        },
      },
    ],
  ])("accepts %s", async (_label, payload) => {
    expect(await hiddenColumnsErrors(payload)).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["an unknown kind", { budgets: ["status"] }],
    ["an unknown id", { transactions: ["amount"] }],
    ["a duplicate id", { transactions: ["tags", "tags"] }],
    ["a non-array value", { transactions: "status" }],
    ["an array at the top level", ["transactions"]],
    // A real own key, as a JSON body carries it; class-transformer alone would
    // skip it and leave `{}`.
    ["a __proto__ key", JSON.parse('{"__proto__": ["status"]}')],
  ])("refuses %s with an error naming the field", async (_label, value) => {
    const errors = await hiddenColumnsErrors({ hiddenTableColumns: value });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe("hiddenTableColumns");
    expect(Object.values(errors[0].constraints ?? {}).join(" ")).toContain(
      "hiddenTableColumns",
    );
  });

  it("still refuses an unknown field beside it", async () => {
    const errors = await hiddenColumnsErrors({
      hiddenTableColumns: { transactions: ["status"] },
      hiddenColumns: { transactions: ["status"] },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe("hiddenColumns");
    expect(errors[0].constraints).toHaveProperty("whitelistValidation");
  });
});

async function viewDefaultsErrors(payload: Record<string, unknown>) {
  const dto = plainToInstance(UpdatePreferencesDto, payload);
  return validate(dto, { whitelist: true, forbidNonWhitelisted: true });
}

describe("UpdatePreferencesDto viewDefaults validation", () => {
  it.each<[string, Record<string, unknown>]>([
    ["omitted", {}],
    ["an empty map", { viewDefaults: {} }],
    [
      "every key set",
      {
        viewDefaults: {
          density: "dense",
          hideRegisterYear: true,
          widgetsCollapsed: false,
          chartCollapsed: true,
          accountOpenTarget: "dashboard",
        },
      },
    ],
  ])("accepts %s", async (_label, payload) => {
    expect(await viewDefaultsErrors(payload)).toEqual([]);
  });

  it.each<[string, unknown]>([
    ["an unknown key", { rowHeight: "dense" }],
    ["an unknown density", { density: "tiny" }],
    ["a string where a flag belongs", { chartCollapsed: "true" }],
    ["an array at the top level", ["density"]],
    // The column is NOT NULL: a null that passed would be a 500, not a 400.
    ["null", null],
    // A real own key, as a JSON body carries it; class-transformer alone would
    // skip it and leave `{}`.
    ["a __proto__ key", JSON.parse('{"__proto__": true}')],
  ])("refuses %s with an error naming the field", async (_label, value) => {
    const errors = await viewDefaultsErrors({ viewDefaults: value });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe("viewDefaults");
    expect(Object.values(errors[0].constraints ?? {}).join(" ")).toContain(
      "viewDefaults",
    );
  });
});

async function defaultCurrencyResult(defaultCurrency: unknown) {
  const dto = plainToInstance(UpdatePreferencesDto, { defaultCurrency });
  const errors = await validate(dto);
  return {
    error: errors.find((e) => e.property === "defaultCurrency"),
    value: dto.defaultCurrency,
  };
}

describe("UpdatePreferencesDto defaultCurrency validation", () => {
  it.each(["q#!", "", "US", "USDD", "U5D", 123])(
    "rejects %p",
    async (value) => {
      expect((await defaultCurrencyResult(value)).error).toBeDefined();
    },
  );

  it("accepts a code and upper-cases a lower-case one", async () => {
    expect((await defaultCurrencyResult("USD")).error).toBeUndefined();
    const lower = await defaultCurrencyResult("pln");
    expect(lower.error).toBeUndefined();
    expect(lower.value).toBe("PLN");
  });

  it("accepts an omitted value (optional)", async () => {
    expect((await defaultCurrencyResult(undefined)).error).toBeUndefined();
  });
});
