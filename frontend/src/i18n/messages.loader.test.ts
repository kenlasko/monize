import { describe, it, expect } from "vitest";
import { loadMessages } from "./messages";

/**
 * Behavioural coverage for the regional-variant loading path in `messages.ts`:
 * a variant inherits its base per key (any key it does not override, and any
 * namespace it omits entirely, falls back to the base), while the keys it does
 * declare win.
 */

type Tree = Record<string, unknown>;

function flatten(obj: Tree, prefix = ""): Record<string, unknown> {
  return Object.entries(obj).reduce<Record<string, unknown>>((acc, [k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      Object.assign(acc, flatten(v as Tree, key));
    } else {
      acc[key] = v;
    }
    return acc;
  }, {});
}

describe("loadMessages (regional variants)", () => {
  it("en-CA inherits en wholesale (it ships no overrides)", async () => {
    const [en, ca] = await Promise.all([
      loadMessages("en"),
      loadMessages("en-CA"),
    ]);
    expect(ca).toEqual(en);
  });

  it("en-US resolves every en key via per-key fallback", async () => {
    const [en, us] = await Promise.all([
      loadMessages("en"),
      loadMessages("en-US"),
    ]);
    expect(Object.keys(flatten(us)).sort()).toEqual(
      Object.keys(flatten(en)).sort(),
    );
  });

  it("en-US applies American overrides where it declares them", async () => {
    const [en, us] = await Promise.all([
      loadMessages("en"),
      loadMessages("en-US"),
    ]);
    const enFlat = flatten(en);
    const usFlat = flatten(us);

    const differing = Object.keys(enFlat).filter((k) => usFlat[k] !== enFlat[k]);
    expect(differing.length).toBeGreaterThan(0);

    // Concrete override: the Canadian "Chequing" account-type label is American
    // "Checking" under en-US, while the base keeps "Chequing".
    expect(enFlat["common.accountTypes.CHEQUING"]).toBe("Chequing");
    expect(usFlat["common.accountTypes.CHEQUING"]).toBe("Checking");
  });
});
