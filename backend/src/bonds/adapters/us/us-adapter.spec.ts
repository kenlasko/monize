import {
  INSTALLED_BOND_ADAPTERS,
  templateFaceValueOf,
} from "../../bond-adapters";
import { EMPTY_CALENDAR_REGISTRY } from "../../domain/calendar-registry";
import { TRACKED_PROVIDERS } from "../../../provider-health/providers";
import { registerUsCalendars, UNITED_STATES_BOND_ADAPTER, usCalendar } from ".";

describe("US adapter", () => {
  const adapter = UNITED_STATES_BOND_ADAPTER;

  it("is installed", () => {
    expect(INSTALLED_BOND_ADAPTERS).toContain(adapter);
  });

  it("names its country, zone and spec", () => {
    expect(adapter.countryCode).toBe("US");
    expect(adapter.timezone).toBe("America/New_York");
    expect(adapter.specDoc).toBe("docs/specs/us-treasury-securities.md");
  });

  it("registers the calendar under its id", () => {
    const registry = registerUsCalendars(EMPTY_CALENDAR_REGISTRY);
    expect(registry.get("US")).toBe(usCalendar);
    expect(EMPTY_CALENDAR_REGISTRY.size).toBe(0);
    expect(() => registerUsCalendars(registry)).toThrow();
  });

  it("offers BILL, NOTE and BOND, each of 100 USD face, with the issuer's page", () => {
    expect(adapter.programs).toEqual([
      {
        issuerCountryCode: "US",
        issuerCode: "US_TREASURY",
        programCode: "BILL",
        currency: "USD",
        faceValue: "100",
        infoUrl:
          "https://www.treasurydirect.gov/marketable-securities/treasury-bills/",
      },
      {
        issuerCountryCode: "US",
        issuerCode: "US_TREASURY",
        programCode: "NOTE",
        currency: "USD",
        faceValue: "100",
        infoUrl:
          "https://www.treasurydirect.gov/marketable-securities/treasury-notes/",
      },
      {
        issuerCountryCode: "US",
        issuerCode: "US_TREASURY",
        programCode: "BOND",
        currency: "USD",
        faceValue: "100",
        infoUrl:
          "https://www.treasurydirect.gov/marketable-securities/treasury-bonds/",
      },
    ]);
    expect(
      templateFaceValueOf({
        issuerCountryCode: "US",
        issuerCode: "US_TREASURY",
        programCode: "NOTE",
      }),
    ).toBe("100");
  });

  it("fetches series under the TreasuryDirect provider and offers nothing else of the series members", () => {
    expect(adapter.seriesProviderId).toBe("treasurydirect");
    expect(Object.keys(TRACKED_PROVIDERS)).toContain("treasurydirect");
    expect(adapter.fetchSeries).toEqual(expect.any(Function));
    expect(adapter.manualSeries).toBeUndefined();
    expect(adapter.currentSeries).toBeUndefined();
    expect(adapter.backfillCodes).toBeUndefined();
    expect(adapter.seriesCodeFor).toBeUndefined();
    expect(adapter.seriesValidFrom).toBeUndefined();
  });

  it("names a bill by its code and knows nothing else", () => {
    expect(adapter.programOf?.("912797WM5261001")).toBe("BILL");
    expect(adapter.programOf?.("91282CZK0")).toBeNull();
    expect(adapter.programOf?.("EDO1036")).toBeNull();
  });
});
