import { DataSource } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { readKmyFixture } from "./__fixtures__/kmy-fixtures";
import { KmyParserService } from "./kmy-parser.service";
import { KmyNotAKmyMoneyFileError } from "./model/kmy-errors";

jest.mock("../../common/db/scoped-db");
const mockedScopedDb = withScopedDb as jest.MockedFunction<typeof withScopedDb>;

describe("KmyParserService", () => {
  let userPreferences: { findOne: jest.Mock };
  let currencies: { find: jest.Mock };
  let service: KmyParserService;

  beforeEach(() => {
    userPreferences = { findOne: jest.fn().mockResolvedValue(null) };
    currencies = { find: jest.fn().mockResolvedValue([]) };
    const manager = {
      getRepository: (entity: { name: string }) =>
        entity.name === "Currency" ? currencies : userPreferences,
    };
    mockedScopedDb.mockImplementation(((
      _ds: unknown,
      fn: (m: unknown) => unknown,
    ) => fn(manager)) as unknown as typeof withScopedDb);
    service = new KmyParserService({} as DataSource);
  });

  afterEach(() => jest.resetAllMocks());

  it("reads the preference and the coins in one scoped read", async () => {
    userPreferences.findOne.mockResolvedValue({ defaultCurrency: "CAD" });
    currencies.find.mockResolvedValue([{ code: "BTC", decimalPlaces: 8 }]);

    await service.parse({
      userId: "user-1",
      buffer: readKmyFixture("syntheticKmy"),
      filename: "a.kmy",
    });

    expect(mockedScopedDb).toHaveBeenCalledTimes(1);
    expect(userPreferences.findOne).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(currencies.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { kind: "CRYPTO" } }),
    );
  });

  it("still reads the preference for the phone region when the caller supplies a currency", async () => {
    userPreferences.findOne.mockResolvedValue({ defaultCurrency: "CAD" });
    const parsed = await service.parse({
      userId: "user-1",
      buffer: readKmyFixture("syntheticKmy"),
      filename: "a.kmy",
      userDefaultCurrency: "EUR",
    });
    expect(userPreferences.findOne).toHaveBeenCalledTimes(1);
    expect(parsed.baseCurrency).toBe("USD");
  });

  it("parses the same bytes to equal handles twice", async () => {
    const input = {
      userId: "user-1",
      buffer: readKmyFixture("syntheticKmy"),
      filename: "a.kmy",
      asOf: "2026-01-01",
    };
    const first = await service.parse(input);
    const second = await service.parse(input);
    expect(second.accounts.accounts.map((a) => a.key)).toEqual(
      first.accounts.accounts.map((a) => a.key),
    );
    expect([...second.expectedBalances]).toEqual([...first.expectedBalances]);
  });

  it("lets a typed refusal propagate", async () => {
    await expect(
      service.parse({
        userId: "user-1",
        buffer: Buffer.from("not a kmy file at all"),
        filename: "a.kmy",
      }),
    ).rejects.toBeInstanceOf(KmyNotAKmyMoneyFileError);
  });
});
