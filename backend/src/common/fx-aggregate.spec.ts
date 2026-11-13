import { FxAggregate } from "./fx-aggregate";
import { roundMoney } from "./round.util";

/**
 * The numerical examples in docs/specs/fx-conversion-completeness.md section 4,
 * plus the distinctions that section calls out as the point of the type.
 */
describe("FxAggregate", () => {
  it("is complete and zero before anything is added", () => {
    // Nothing to convert is a known answer, not an unknown one: an empty
    // account holds zero, and reporting that as unavailable tells the user a
    // settled question could not be worked out.
    const agg = new FxAggregate();
    expect(agg.total).toBe(0);
    expect(agg.knownSubtotal).toBe(0);
    expect(agg.isComplete).toBe(true);
    expect(agg.missingPairs).toEqual([]);
  });

  describe("rounds each component like roundMoney (Discussion #2136)", () => {
    it.each([0.00005, -0.00005, 0.00015, -0.00015, 0.00145, -1.00145, 2.5])(
      "%p, through add and addConverted",
      (amount) => {
        const added = new FxAggregate();
        added.add(amount, "USD", "EUR");
        const converted = new FxAggregate();
        converted.addConverted(amount);
        expect(added.total).toBe(roundMoney(amount, 4));
        expect(converted.total).toBe(roundMoney(amount, 4));
      },
    );

    it("rounds a negative midpoint away from zero, not toward it", () => {
      const agg = new FxAggregate();
      agg.addConverted(-0.00005);
      expect(agg.total).toBe(-0.0001);
      expect(agg.knownSubtotal).toBe(-0.0001);
    });

    it("rounds a midpoint the float multiply lands under upward", () => {
      // 0.00145 * 10000 is 14.499999999999998.
      const agg = new FxAggregate();
      agg.add(0.00145, "USD", "EUR");
      expect(agg.total).toBe(0.0015);
    });
  });

  it("sums converted components", () => {
    const agg = new FxAggregate();
    agg.add(900, "USD", "EUR");
    agg.add(500, "EUR", "EUR");
    expect(agg.total).toBe(1400);
    expect(agg.knownSubtotal).toBe(1400);
    expect(agg.isComplete).toBe(true);
  });

  it("makes the total unknown when a component could not convert", () => {
    const agg = new FxAggregate();
    agg.add(500, "EUR", "EUR");
    agg.add(null, "USD", "EUR");
    expect(agg.total).toBeNull();
    // The part that did convert is still available, under its own name.
    expect(agg.knownSubtotal).toBe(500);
    expect(agg.missingPairs).toEqual(["USD->EUR"]);
    expect(agg.isComplete).toBe(false);
  });

  it("distinguishes 'nothing to convert' from 'could not convert'", () => {
    // Both have a knownSubtotal of 0. Only missingPairs tells them apart, which
    // is why it is not optional -- this is the exact confusion that made a
    // missing rate indistinguishable from a real 1:1.
    const empty = new FxAggregate();
    const failed = new FxAggregate();
    failed.add(null, "USD", "EUR");

    expect(empty.knownSubtotal).toBe(failed.knownSubtotal);
    expect(empty.total).toBe(0);
    expect(failed.total).toBeNull();
    expect(empty.missingPairs).toEqual([]);
    expect(failed.missingPairs).toEqual(["USD->EUR"]);
  });

  it("records each missing pair once and sorts them", () => {
    const agg = new FxAggregate();
    agg.add(null, "USD", "EUR");
    agg.add(null, "USD", "EUR");
    agg.add(null, "GBP", "EUR");
    expect(agg.missingPairs).toEqual(["GBP->EUR", "USD->EUR"]);
  });

  it("keeps the total unknown when only one of three currencies is missing", () => {
    const agg = new FxAggregate();
    agg.add(1000, "EUR", "EUR");
    agg.add(900, "USD", "EUR");
    agg.add(null, "JPY", "EUR");
    expect(agg.total).toBeNull();
    expect(agg.knownSubtotal).toBe(1900);
    expect(agg.missingPairs).toEqual(["JPY->EUR"]);
  });

  it("handles a negative (liability) component that cannot convert", () => {
    const agg = new FxAggregate();
    agg.add(-500, "EUR", "EUR");
    agg.add(null, "USD", "EUR");
    expect(agg.total).toBeNull();
    expect(agg.knownSubtotal).toBe(-500);
  });

  it("addConverted takes a value that needed no conversion", () => {
    const agg = new FxAggregate();
    agg.addConverted(250);
    expect(agg.total).toBe(250);
    expect(agg.isComplete).toBe(true);
  });

  it("addConverted cannot mask a gap recorded elsewhere", () => {
    const agg = new FxAggregate();
    agg.add(null, "USD", "EUR");
    agg.addConverted(250);
    expect(agg.total).toBeNull();
    expect(agg.knownSubtotal).toBe(250);
  });

  it("merge carries the other aggregate's gaps with its subtotal", () => {
    const a = new FxAggregate();
    a.addConverted(100);
    const b = new FxAggregate();
    b.addConverted(50);
    b.add(null, "JPY", "EUR");

    a.merge(b);
    expect(a.knownSubtotal).toBe(150);
    expect(a.total).toBeNull();
    expect(a.missingPairs).toEqual(["JPY->EUR"]);
  });

  it("a zero-valued component that converted keeps the total known", () => {
    const agg = new FxAggregate();
    agg.add(0, "USD", "EUR");
    expect(agg.total).toBe(0);
    expect(agg.isComplete).toBe(true);
  });

  describe("a component whose value is unknown for no nameable pair", () => {
    it("withholds the total without blaming a currency", () => {
      const agg = new FxAggregate();
      agg.add(500, "EUR", "EUR");
      agg.addUnknown();

      expect(agg.total).toBeNull();
      expect(agg.knownSubtotal).toBe(500);
      // Naming a pair here would send the reader to refresh a rate that exists:
      // the component is unknown in every currency.
      expect(agg.missingPairs).toEqual([]);
      expect(agg.unknownCount).toBe(1);
      expect(agg.isComplete).toBe(false);
    });

    it("carries through merge", () => {
      const a = new FxAggregate();
      const b = new FxAggregate();
      a.addConverted(100);
      b.addUnknown();
      a.merge(b);

      expect(a.total).toBeNull();
      expect(a.knownSubtotal).toBe(100);
      expect(a.unknownCount).toBe(1);
    });

    it("leaves a total with nothing missing complete", () => {
      const agg = new FxAggregate();
      agg.addConverted(100);
      expect(agg.unknownCount).toBe(0);
      expect(agg.isComplete).toBe(true);
      expect(agg.total).toBe(100);
    });
  });

  it("accumulates money without floating-point drift (CLAUDE.md Financial Math)", () => {
    // 0.1 + 0.1 + 0.1 === 0.30000000000000004 in bare float addition; the
    // accumulator must fold through integer ten-thousandths instead.
    const agg = new FxAggregate();
    agg.add(0.1, "USD", "EUR");
    agg.add(0.1, "USD", "EUR");
    agg.addConverted(0.1);
    expect(agg.total).toBe(0.3);

    // The same via merge: drift must not sneak in through the combine path.
    const a = new FxAggregate();
    const b = new FxAggregate();
    for (let i = 0; i < 10; i++) {
      a.addConverted(0.1);
      b.addConverted(0.2);
    }
    a.merge(b);
    expect(a.total).toBe(3);
  });
});
