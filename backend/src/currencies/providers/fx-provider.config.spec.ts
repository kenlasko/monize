import {
  DEFAULT_FX_PROVIDERS,
  FxProviderConfigError,
  resolveFxProviders,
} from "./fx-provider.config";
import {
  FX_PROVIDER_NAMES,
  PAIR_PROVIDER_NAMES,
} from "./fx-provider.interface";

describe("resolveFxProviders", () => {
  it("answers the default list when FX_PROVIDERS is unset", () => {
    expect(resolveFxProviders(undefined)).toEqual([...DEFAULT_FX_PROVIDERS]);
    expect(resolveFxProviders(null)).toEqual([...DEFAULT_FX_PROVIDERS]);
  });

  it("answers the default list when FX_PROVIDERS is empty or only separators", () => {
    expect(resolveFxProviders("")).toEqual([...DEFAULT_FX_PROVIDERS]);
    expect(resolveFxProviders("   ")).toEqual([...DEFAULT_FX_PROVIDERS]);
    expect(resolveFxProviders(" , ,")).toEqual([...DEFAULT_FX_PROVIDERS]);
  });

  it("answers a copy of the default, so a caller cannot edit the constant", () => {
    const resolved = resolveFxProviders(undefined);
    expect(resolved).not.toBe(DEFAULT_FX_PROVIDERS);
  });

  it("every default name is a valid provider name", () => {
    for (const name of DEFAULT_FX_PROVIDERS) {
      expect(FX_PROVIDER_NAMES).toContain(name);
    }
  });

  it("the default is frankfurter,yahoo: a deployment that sets nothing asks Frankfurter first", () => {
    // Decision 2 of the plan, applied in task R1.
    expect(DEFAULT_FX_PROVIDERS).toEqual(["frankfurter", "yahoo"]);
  });

  it("accepts frankfurter and keeps the order the operator wrote", () => {
    expect(resolveFxProviders("frankfurter,yahoo")).toEqual([
      "frankfurter",
      "yahoo",
    ]);
    expect(resolveFxProviders("yahoo, Frankfurter")).toEqual([
      "yahoo",
      "frankfurter",
    ]);
    expect(resolveFxProviders("frankfurter")).toEqual(["frankfurter"]);
  });

  it("trims and lower-cases each token", () => {
    expect(resolveFxProviders(" Yahoo ")).toEqual(["yahoo"]);
    expect(resolveFxProviders("YAHOO")).toEqual(["yahoo"]);
  });

  it("drops a repeated name, keeping its first position, and ignores blank tokens", () => {
    expect(resolveFxProviders("yahoo, ,YAHOO,yahoo")).toEqual(["yahoo"]);
  });

  it("refuses an unknown name, naming the token and the valid names", () => {
    let caught: unknown;
    try {
      resolveFxProviders("yahoo,yahooo");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FxProviderConfigError);
    const error = caught as FxProviderConfigError;
    expect(error.token).toBe("yahooo");
    expect(error.validNames).toEqual(FX_PROVIDER_NAMES);
    expect(error.message).toContain('"yahooo"');
    expect(error.message).toContain("FX_PROVIDERS");
    for (const name of FX_PROVIDER_NAMES) {
      expect(error.message).toContain(name);
    }
  });

  it("refuses rather than skipping: a valid name beside the bad one does not rescue the list", () => {
    expect(() => resolveFxProviders("nope,yahoo")).toThrow(
      FxProviderConfigError,
    );
  });

  it("refuses the always-present crypto provider as a token: it is not configurable", () => {
    // Appended by the module factory whatever FX_PROVIDERS says
    // (docs/specs/crypto-accounts.md, decision 5), so naming it is a typo of
    // some other intent, not a request.
    for (const name of PAIR_PROVIDER_NAMES) {
      expect(FX_PROVIDER_NAMES as readonly string[]).not.toContain(name);
      expect(() => resolveFxProviders(`frankfurter,${name}`)).toThrow(
        FxProviderConfigError,
      );
    }
  });
});
