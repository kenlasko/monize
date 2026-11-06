import { EntityManager, In } from "typeorm";
import { Currency } from "../currencies/entities/currency.entity";
import {
  loadCurrencyPlaces,
  loadCurrencyPlacesForRead,
  moneyDecimalsForCode,
  precisionCurrencyFor,
} from "./currency-places.util";

function managerReturning(rows: { code: string; decimalPlaces: unknown }[]) {
  const find = jest.fn().mockResolvedValue(rows);
  const query = jest.fn().mockResolvedValue(
    rows.map((row) => ({
      code: row.code,
      decimal_places: row.decimalPlaces,
    })),
  );
  const getRepository = jest.fn().mockReturnValue({ find, query });
  return {
    manager: { getRepository } as unknown as EntityManager,
    find,
    query,
    getRepository,
  };
}

describe("loadCurrencyPlaces", () => {
  it("reads every distinct code in one locking query on the caller's manager", async () => {
    const { manager, find, query, getRepository } = managerReturning([
      { code: "BTC", decimalPlaces: 8 },
      { code: "CAD", decimalPlaces: 2 },
    ]);

    const places = await loadCurrencyPlaces(manager, [
      "btc",
      "CAD",
      "BTC",
      null,
      undefined,
      "",
    ]);

    expect(getRepository).toHaveBeenCalledWith(Currency);
    expect(find).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
    // FOR KEY SHARE, parameterized, in code order: a lowering of
    // decimal_places in flight (FOR UPDATE) is waited out and re-read, and
    // one arriving later waits for the write.
    expect(query).toHaveBeenCalledWith(
      "SELECT code, decimal_places FROM currencies WHERE code = ANY($1::varchar[]) ORDER BY code FOR KEY SHARE",
      [["BTC", "CAD"]],
    );
    expect([...places.entries()]).toEqual([
      ["BTC", 8],
      ["CAD", 2],
    ]);
  });

  it("asks nothing when there is no code to read", async () => {
    const { manager, query } = managerReturning([]);
    const places = await loadCurrencyPlaces(manager, [null, ""]);
    expect(query).not.toHaveBeenCalled();
    expect(places.size).toBe(0);
  });

  it("coerces a driver's smallint string to a number", async () => {
    const { manager } = managerReturning([{ code: "ETH", decimalPlaces: "6" }]);
    const places = await loadCurrencyPlaces(manager, ["ETH"]);
    expect(places.get("ETH")).toBe(6);
  });
});

describe("loadCurrencyPlacesForRead", () => {
  it("reads every distinct code in one unlocked query on the caller's manager", async () => {
    const { manager, find, query, getRepository } = managerReturning([
      { code: "BTC", decimalPlaces: 8 },
      { code: "CAD", decimalPlaces: 2 },
    ]);

    const places = await loadCurrencyPlacesForRead(manager, [
      "btc",
      "CAD",
      "BTC",
      null,
    ]);

    expect(getRepository).toHaveBeenCalledWith(Currency);
    expect(query).not.toHaveBeenCalled();
    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({
      select: { code: true, decimalPlaces: true },
      where: { code: In(["BTC", "CAD"]) },
    });
    expect([...places.entries()]).toEqual([
      ["BTC", 8],
      ["CAD", 2],
    ]);
  });

  it("asks nothing when there is no code to read", async () => {
    const { manager, find } = managerReturning([]);
    const places = await loadCurrencyPlacesForRead(manager, [undefined]);
    expect(find).not.toHaveBeenCalled();
    expect(places.size).toBe(0);
  });

  it("coerces a driver's smallint string to a number", async () => {
    const { manager } = managerReturning([{ code: "ETH", decimalPlaces: "6" }]);
    const places = await loadCurrencyPlacesForRead(manager, ["ETH"]);
    expect(places.get("ETH")).toBe(6);
  });
});

describe("moneyDecimalsForCode", () => {
  const places = new Map([
    ["BTC", 8],
    ["CAD", 2],
    ["JPY", 0],
    ["XC6", 6],
  ]);

  it("is the coin's own places and four for fiat", () => {
    expect(moneyDecimalsForCode(places, "BTC")).toBe(8);
    expect(moneyDecimalsForCode(places, "btc")).toBe(8);
    expect(moneyDecimalsForCode(places, "XC6")).toBe(6);
    expect(moneyDecimalsForCode(places, "CAD")).toBe(4);
    expect(moneyDecimalsForCode(places, "JPY")).toBe(4);
  });

  it("reads a code it does not hold, or none, as the column default", () => {
    expect(moneyDecimalsForCode(places, "EUR")).toBe(4);
    expect(moneyDecimalsForCode(places, null)).toBe(4);
    expect(moneyDecimalsForCode(places, undefined)).toBe(4);
  });
});

describe("precisionCurrencyFor", () => {
  it("carries the loaded places, or null for an unknown code", () => {
    const places = new Map([["BTC", 8]]);
    expect(precisionCurrencyFor(places, "btc")).toEqual({
      code: "btc",
      decimalPlaces: 8,
    });
    expect(precisionCurrencyFor(places, "EUR")).toEqual({
      code: "EUR",
      decimalPlaces: null,
    });
  });
});
