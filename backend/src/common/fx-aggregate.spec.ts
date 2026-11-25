import { FxAggregate, shareOf } from "./fx-aggregate";
import { moneyUnits, roundMoney } from "./round.util";

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

  describe("rounds a lone component like roundMoney (Discussion #2136)", () => {
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

    it("rounds a float artefact just under a midpoint up, as roundMoney does", () => {
      // 41919.85225 computed in floats; read back from its accumulated units
      // without roundMoney's one-ULP nudge it came back 41919.8522 (issue
      // #2360).
      const agg = new FxAggregate();
      agg.addConverted(41919.852249999996);
      expect(agg.total).toBe(roundMoney(41919.852249999996, 4));
      expect(agg.total).toBe(41919.8523);
    });

    it("rounds a midpoint the float multiply lands under upward", () => {
      // 0.00145 * 10000 is 14.499999999999998.
      const agg = new FxAggregate();
      agg.add(0.00145, "USD", "EUR");
      expect(agg.total).toBe(0.0015);
    });
  });

  describe("rounds once, after summing (issue #2360)", () => {
    it("converts each row at full precision and rounds the sum", () => {
      // Two 100.01 EUR receipts at 1.2474 USD are 124.752474 each. Rounded
      // one by one they summed to 249.5050; their sum is 249.504948.
      const perRow = new FxAggregate();
      perRow.add(100.01 * 1.2474, "EUR", "USD");
      perRow.add(100.01 * 1.2474, "EUR", "USD");
      expect(perRow.total).toBe(249.5049);
    });

    it("agrees with converting the rows' sum", () => {
      const perRow = new FxAggregate();
      perRow.add(100.01 * 1.2474, "EUR", "USD");
      perRow.add(100.01 * 1.2474, "EUR", "USD");
      const summed = new FxAggregate();
      summed.add(200.02 * 1.2474, "EUR", "USD");
      expect(perRow.total).toBe(summed.total);
    });

    it("rounds the merged sum, not each side", () => {
      const a = new FxAggregate();
      a.addConverted(124.752474);
      const b = new FxAggregate();
      b.addConverted(124.752474);
      a.merge(b);
      expect(a.knownSubtotal).toBe(249.5049);
    });

    it("holds a small component at its own digits, not twelve places (issue #2414)", () => {
      // 7.681 EUR at 1.2475589116 is exactly 9.5824999999996, and two are
      // 19.1649999999992, which reads 19.16. Twelve places read each as
      // 9.5825, so the two summed to 19.165 and read 19.17; converting their
      // 15.362 sum read 19.16, so the figure moved with the grouping.
      const rate = 1.2475589116;
      const perRow = new FxAggregate();
      perRow.add(7.681 * rate, "EUR", "USD");
      perRow.add(7.681 * rate, "EUR", "USD");
      const summed = new FxAggregate();
      summed.add(15.362 * rate, "EUR", "USD");
      expect(perRow.knownSubtotalAt(2)).toBe(19.16);
      expect(summed.knownSubtotalAt(2)).toBe(19.16);
    });

    it("still drops a double's own noise, past its fifteen digits", () => {
      // 100.01 * 1.2474 carries float noise below 124.752474's last digit; a
      // share of two equal parts is still exactly a half.
      const part = new FxAggregate();
      part.add(100.01 * 1.2474, "EUR", "USD");
      const whole = new FxAggregate();
      whole.merge(part);
      whole.merge(part);
      expect(part.unroundedSubtotal / whole.unroundedSubtotal).toBe(0.5);
      expect(part.unroundedSubtotal).toBe(124.752474);
    });

    it("lets sub-unit components add up to a unit", () => {
      // Each rounds to 0.0000 alone; together they are 0.0002.
      const agg = new FxAggregate();
      for (let i = 0; i < 5; i++) agg.addConverted(0.00004);
      expect(agg.total).toBe(0.0002);
    });

    it("rounds a negative sum away from zero", () => {
      const agg = new FxAggregate();
      agg.addConverted(-0.000025);
      agg.addConverted(-0.000025);
      expect(agg.total).toBe(-0.0001);
    });
  });

  describe("scales a large amount exactly (Discussion #2343)", () => {
    it("cancels an amount added and then subtracted to zero", () => {
      // 300000000000.03 * 10000 is 3000000000000300.5 in floats, which
      // Math.round carried up for the positive amount and toward zero for the
      // negative one, leaving 0.0001.
      const total = new FxAggregate();
      total.addConverted(300_000_000_000.03);
      total.addConverted(-300_000_000_000.03);
      expect(total.total).toBe(0);
      expect(total.knownSubtotal).toBe(0);
    });

    it("cancels the same pair through add", () => {
      const agg = new FxAggregate();
      agg.add(300_000_000_000.03, "USD", "EUR");
      agg.add(-300_000_000_000.03, "USD", "EUR");
      expect(agg.total).toBe(0);
    });

    it("reads a large amount back unchanged", () => {
      const agg = new FxAggregate();
      agg.addConverted(300_000_000_000.03);
      expect(agg.total).toBe(300_000_000_000.03);
      expect(agg.total).toBe(roundMoney(300_000_000_000.03, 4));
    });

    it("leaves no residue after a hundred cancelling pairs", () => {
      // The float scaling left 0.01 here: 0.0001 per pair.
      const agg = new FxAggregate();
      for (let i = 0; i < 100; i++) {
        agg.addConverted(300_000_000_000.03);
        agg.addConverted(-300_000_000_000.03);
      }
      expect(agg.total).toBe(0);
    });

    it("stays exact once the running subtotal passes 2^53 ten-thousandths", () => {
      // 9000000000000001 + 9000000000000002 is 18000000000000003 units, which a
      // double cannot hold; a float accumulator came back 0.0001 after the two
      // amounts were taken out again.
      const agg = new FxAggregate();
      agg.addConverted(900_000_000_000.0001);
      agg.addConverted(900_000_000_000.0002);
      expect(agg.total).toBe(1_800_000_000_000.0002);
      agg.addConverted(-900_000_000_000.0001);
      agg.addConverted(-900_000_000_000.0002);
      expect(agg.total).toBe(0);
    });

    it("stays exact through merge", () => {
      const a = new FxAggregate();
      a.addConverted(300_000_000_000.03);
      const b = new FxAggregate();
      b.addConverted(-300_000_000_000.03);
      a.merge(b);
      expect(a.total).toBe(0);
    });
  });

  describe("a non-finite component", () => {
    // Not a number of ten-thousandths, so it cannot join the BigInt subtotal;
    // it reads through exactly as it did when the subtotal was a double.
    it.each([NaN, Infinity, -Infinity])(
      "%p reads through the subtotal as before",
      (amount) => {
        const agg = new FxAggregate();
        agg.addConverted(100);
        agg.add(amount, "USD", "EUR");
        expect(agg.knownSubtotal).toBe(100 + amount);
        expect(agg.total).toBe(100 + amount);
        expect(agg.missingPairs).toEqual([]);
        expect(agg.unknownCount).toBe(0);
      },
    );

    it("carries through merge", () => {
      const a = new FxAggregate();
      a.addConverted(100);
      const b = new FxAggregate();
      b.addConverted(Infinity);
      a.merge(b);
      expect(a.total).toBe(Infinity);
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

  describe("folds a part exactly, never its rounded reading (issue #2384)", () => {
    it("subtracts a negated part before rounding", () => {
      // Two expense cells of -124.752474 read 124.7525 each; their sum is
      // 249.504948, which reads 249.5049.
      const total = new FxAggregate();
      for (let i = 0; i < 2; i++) {
        const cell = new FxAggregate();
        cell.addConverted(-100.01 * 1.2474);
        total.mergeNegated(cell);
      }
      expect(total.total).toBe(249.5049);
    });

    it("carries a negated part's gaps", () => {
      const part = new FxAggregate();
      part.addConverted(10);
      part.add(null, "EUR", "USD");
      part.addUnknown();
      const total = new FxAggregate();
      total.mergeNegated(part);
      expect(total.total).toBeNull();
      expect(total.knownSubtotal).toBe(-10);
      expect(total.missingPairs).toEqual(["EUR->USD"]);
      expect(total.unknownCount).toBe(1);
    });

    it("cancels a part merged and merged negated", () => {
      const part = new FxAggregate();
      part.addConverted(300000000000.03);
      part.addConverted(0.00004);
      const total = new FxAggregate();
      total.merge(part);
      total.mergeNegated(part);
      expect(total.total).toBe(0);
      expect(total.sign).toBe(0);
    });

    it("negates a non-finite part", () => {
      const part = new FxAggregate();
      part.addConverted(Infinity);
      const total = new FxAggregate();
      total.mergeNegated(part);
      expect(total.knownSubtotal).toBe(-Infinity);
    });
  });

  describe("unroundedSubtotal (issue #2384)", () => {
    it("reads the accumulated sum a mean or a share divides", () => {
      const agg = new FxAggregate();
      agg.addConverted(100.01 * 1.2474);
      agg.addConverted(100.03 * 1.2474);
      expect(agg.knownSubtotal).toBe(249.5299);
      expect(agg.unroundedSubtotal).toBe(249.529896);
      expect(roundMoney(agg.unroundedSubtotal / 2)).toBe(124.7649);
    });

    it("carries a non-finite component", () => {
      const agg = new FxAggregate();
      agg.addConverted(1);
      agg.addConverted(-Infinity);
      expect(agg.unroundedSubtotal).toBe(-Infinity);
    });
  });

  describe("sign is judged before rounding (issue #2384)", () => {
    it.each([
      [0.00003, 1],
      [-0.00003, -1],
      [0.00000001, 1],
      [-0.00000001, -1],
      [0.000000005, 1],
      [0.000000004, 0],
      [-0.000000004, 0],
      [0, 0],
      [1234.5, 1],
    ])("%p has sign %p", (amount, expected) => {
      const agg = new FxAggregate();
      agg.addConverted(amount);
      expect(agg.sign).toBe(expected);
    });

    it("reads a small net that rounds to zero as a sign, not as nothing", () => {
      const agg = new FxAggregate();
      agg.addConverted(-100);
      agg.addConverted(100.00003);
      expect(agg.knownSubtotal).toBe(0);
      expect(agg.sign).toBe(1);
    });

    it("reads the float residue of large cancelling components as zero", () => {
      // 16,768.69 spent at 9731.4245182213 and refunded as 4,012.32 and
      // 12,756.37 at the same rate: three doubles near 163 million whose sum
      // is -0.00000002, residue over half a unit at eight places, not money.
      const rate = 9731.4245182213;
      const agg = new FxAggregate();
      agg.addConverted(16768.69 * rate);
      agg.addConverted(-4012.32 * rate);
      agg.addConverted(-12756.37 * rate);
      expect(agg.unroundedSubtotal).toBe(-0.00000002);
      expect(agg.knownSubtotal).toBe(0);
      expect(agg.sign).toBe(0);
    });

    it("carries the components' size through merge and mergeNegated", () => {
      const rate = 9731.4245182213;
      const spent = new FxAggregate();
      spent.addConverted(16768.69 * rate);
      const refunds = new FxAggregate();
      refunds.addConverted(4012.32 * rate);
      refunds.addConverted(12756.37 * rate);
      expect(FxAggregate.difference(spent, refunds).sign).toBe(0);
      const net = new FxAggregate();
      net.merge(spent);
      net.mergeNegated(refunds);
      expect(net.sign).toBe(0);
    });

    it("ignores a missing component, as the subtotal does", () => {
      const agg = new FxAggregate();
      agg.add(null, "EUR", "USD");
      agg.addConverted(-5);
      expect(agg.sign).toBe(-1);
    });

    it("is NaN once a NaN component was added", () => {
      const agg = new FxAggregate();
      agg.addConverted(NaN);
      expect(agg.sign).toBeNaN();
    });
  });

  describe("difference (issue #2384)", () => {
    it("nets two aggregates before either is rounded, with both's gaps", () => {
      const income = new FxAggregate();
      income.addConverted(124.752474);
      income.add(null, "EUR", "USD");
      const expenses = new FxAggregate();
      expenses.addConverted(0.000049896);
      expenses.addUnknown();
      const net = FxAggregate.difference(income, expenses);
      expect(income.knownSubtotal - expenses.knownSubtotal).toBe(124.7525);
      expect(net.knownSubtotal).toBe(124.7524);
      expect(net.total).toBeNull();
      expect(net.missingPairs).toEqual(["EUR->USD"]);
      expect(net.unknownCount).toBe(1);
      expect(income.knownSubtotal).toBe(124.7525);
    });
  });

  describe("apportionUnits (issue #2384)", () => {
    const part = (...amounts: number[]): FxAggregate => {
      const agg = new FxAggregate();
      for (const amount of amounts) agg.addConverted(amount);
      return agg;
    };

    it("splits the parent's single rounding between two equal children", () => {
      // 124.752474 + 124.752474 = 249.504948, which reads 249.5049; each child
      // alone reads 124.7525, so one of them gives up its unit.
      const units = FxAggregate.apportionUnits(
        [part(100.01 * 1.2474), part(100.01 * 1.2474)],
        4,
      );
      expect(units).toEqual([1247525, 1247524]);
      expect(units[0] + units[1]).toBe(2495049);
    });

    it("gives a unit to the largest remainder first", () => {
      // 0.00004 + 0.00007 = 0.00011, which reads 0.0001: the 0.00007 part
      // keeps the unit.
      expect(
        FxAggregate.apportionUnits([part(0.00004), part(0.00007)], 4),
      ).toEqual([0, 1]);
    });

    it("rounds a negative part down before it adds a unit back", () => {
      // -0.00004 + 0.00007 = 0.00003, which reads 0.0000. The floors are -1
      // and 0 with remainders 0.6 and 0.7, so the one unit short goes to the
      // 0.00007 part: each part stays within a unit of its value.
      expect(
        FxAggregate.apportionUnits([part(-0.00004), part(0.00007)], 4),
      ).toEqual([-1, 1]);
    });

    it("apportions to a given target", () => {
      expect(
        FxAggregate.apportionUnits([part(0.00005), part(0.00005)], 4, 1),
      ).toEqual([1, 0]);
    });

    it("leaves parts already at four places unchanged", () => {
      expect(
        FxAggregate.apportionUnits([part(12.3456), part(-7.0001), part(0)], 4),
      ).toEqual([123456, -70001, 0]);
    });

    it("refuses a target the parts cannot reach within a unit each", () => {
      expect(() =>
        FxAggregate.apportionUnits([part(1), part(2)], 4, 30003),
      ).toThrow(RangeError);
      expect(() =>
        FxAggregate.apportionUnits([part(1), part(2)], 4, 29999),
      ).toThrow(RangeError);
    });

    it("reads each part on its own once one is non-finite", () => {
      expect(
        FxAggregate.apportionUnits([part(0.00005), part(Infinity)], 4),
      ).toEqual([1, Infinity]);
    });

    it("answers nothing for no parts", () => {
      expect(FxAggregate.apportionUnits([], 2)).toEqual([]);
    });

    it.each([0, 2, 4, 8])(
      "keeps every part within one unit of its value and sums to the whole's reading, at %p places",
      (places) => {
        let seed = 2384 + places;
        const next = () => {
          seed = (seed * 1103515245 + 12345) % 2147483648;
          return seed / 2147483648;
        };
        const unit = 10 ** -places;
        for (let round = 0; round < 500; round++) {
          const parts = Array.from({ length: 1 + Math.floor(next() * 6) }, () =>
            part(
              ...Array.from(
                { length: 1 + Math.floor(next() * 3) },
                () => (next() - 0.4) * 10 ** Math.floor(next() * 7),
              ),
            ),
          );
          const units = FxAggregate.apportionUnits(parts, places);
          const whole = new FxAggregate();
          for (const p of parts) whole.merge(p);
          expect(units.reduce((a, b) => a + b, 0)).toBe(
            moneyUnits(whole.knownSubtotalAt(places), places),
          );
          units.forEach((u, i) => {
            expect(
              Math.abs(u * unit - parts[i].knownSubtotalAt(places)),
            ).toBeLessThanOrEqual(unit * (1 + 1e-6) + 1e-9);
          });
        }
      },
    );

    it("apportions a coin's eight places past 2^53 units without refusing its own total (issue #2410)", () => {
      // Three parts summing to 50 to 90 million at eight places: the reading
      // through a double can land a unit off the exact floors, which threw.
      let seed = 2410;
      const next = () => {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        return seed / 2147483648;
      };
      for (let round = 0; round < 20000; round++) {
        const parts = Array.from({ length: 3 }, () =>
          part(Number((1.6e7 + next() * 1.4e7).toFixed(9))),
        );
        const units = FxAggregate.apportionUnits(parts, 8);
        expect(BigInt(units.reduce((a, b) => a + b, 0))).toBe(
          FxAggregate.sum(parts).unitsAt(8),
        );
      }
    });

    it("reads units exactly as knownSubtotalAt where a double holds them", () => {
      for (const value of [2.50498, -0.005, 41919.852249999996, 1234.5]) {
        for (const places of [0, 2, 4]) {
          const agg = part(value);
          expect(agg.unitsAt(places)).toBe(
            BigInt(moneyUnits(agg.knownSubtotalAt(places), places)),
          );
        }
      }
      // Past what a double holds at eight places, the exact rounding: the
      // two parts accumulate to 75061223.834708825 exactly, a half unit.
      const big = part(75061223, 0.834708825);
      expect(big.unitsAt(8)).toBe(7506122383470883n);
    });

    it("apportions in the currency's own unit (issue #2410)", () => {
      // Two 124.752474 children under a 249.504948 parent: the parent reads
      // 249.50 at two places and each child floors to 124.75, so neither
      // takes a cent. In whole yen, two 0.6 children under a 1.2 parent read
      // 1 between them, the tie to the earlier part.
      expect(
        FxAggregate.apportionUnits(
          [part(100.01 * 1.2474), part(100.01 * 1.2474)],
          2,
        ),
      ).toEqual([12475, 12475]);
      expect(FxAggregate.apportionUnits([part(0.6), part(0.6)], 0)).toEqual([
        1, 0,
      ]);
    });

    it("refuses places a subtotal cannot be read at", () => {
      expect(() => FxAggregate.apportionUnits([part(1)], 9)).toThrow(
        RangeError,
      );
    });
  });

  describe("reads a report figure once, at its currency's places (issue #2410)", () => {
    it("rounds 2.50498 to 2.50, not through 2.5050 to 2.51", () => {
      const agg = new FxAggregate();
      agg.addConverted(2 * 1.25249);
      expect(agg.knownSubtotal).toBe(2.505);
      expect(agg.knownSubtotalAt(2)).toBe(2.5);
      expect(agg.totalAt(2)).toBe(2.5);
      expect(roundMoney(agg.knownSubtotal, 2)).toBe(2.51);
    });

    it("rounds the summed components once, at the places asked for", () => {
      // Two 100.01 EUR receipts at 1.2474 USD: 249.504948 reads 249.50, where
      // the two rows alone read 124.75 each.
      const agg = new FxAggregate();
      agg.addConverted(100.01 * 1.2474);
      agg.addConverted(100.01 * 1.2474);
      expect(agg.knownSubtotalAt(2)).toBe(249.5);
      expect(agg.knownSubtotalAt(4)).toBe(249.5049);
    });

    it("reads whole yen, half away from zero for both signs", () => {
      const agg = new FxAggregate();
      agg.addConverted(1234.5);
      expect(agg.knownSubtotalAt(0)).toBe(1235);
      const negative = new FxAggregate();
      negative.addConverted(-0.5);
      expect(negative.knownSubtotalAt(0)).toBe(-1);
    });

    it("keeps a coin's eight places", () => {
      const coin = new FxAggregate();
      coin.addConverted(0.12345678);
      coin.addConverted(0.000000004);
      expect(coin.knownSubtotalAt(8)).toBe(0.12345678);
      expect(coin.knownSubtotal).toBe(0.1235);
    });

    it("withholds a total with a gap at any places", () => {
      const agg = new FxAggregate();
      agg.addConverted(2.50498);
      agg.add(null, "EUR", "USD");
      expect(agg.totalAt(2)).toBeNull();
      expect(agg.knownSubtotalAt(2)).toBe(2.5);
    });

    it("carries a non-finite component", () => {
      const agg = new FxAggregate();
      agg.addConverted(1);
      agg.addConverted(Infinity);
      expect(agg.knownSubtotalAt(2)).toBe(Infinity);
    });

    it.each([-1, 1.5, 9, NaN])("refuses to read at %p places", (places) => {
      expect(() => new FxAggregate().knownSubtotalAt(places)).toThrow(
        RangeError,
      );
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

  describe("shareOf (issue #2414)", () => {
    it("divides the unrounded aggregates, not their readings", () => {
      // Two parts of 1.2474: each reads 1.25 over a whole that reads 2.49.
      const part = new FxAggregate();
      part.addConverted(1.2474);
      const whole = FxAggregate.sum([part, part]);
      expect(shareOf(part, whole)).toBe(50);
    });

    it("is 0 over a whole that is not positive", () => {
      const part = new FxAggregate();
      part.addConverted(1);
      expect(shareOf(part, new FxAggregate())).toBe(0);
    });
  });
});

