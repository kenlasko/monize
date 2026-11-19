import {
  alternateCalendarInput,
  alternateDailyInput,
  fullCalendarInput,
  alternateInputs,
  fullDailyInput,
  fullLedgerInput,
  fullTriviaFactsInput,
} from "./__fixtures__/trivia-pool.fixture";
import { buildTriviaFacts } from "./trivia-facts";
import { buildCalendarTriviaFacts } from "./trivia-calendar-facts";
import { buildDailyTriviaFacts } from "./trivia-daily-facts";
import { buildLedgerTriviaFacts } from "./trivia-ledger-facts";
import {
  familyOf,
  laneOf,
  TRIVIA_FAMILIES,
  type TriviaFamily,
} from "./trivia-families";
import { TRIVIA_FACT_IDS, type TriviaFact } from "./trivia.types";

/** Every fact a builder can produce from the fixtures, one list per builder. */
function builderOutputs(): TriviaFact[][] {
  return [
    buildTriviaFacts(fullTriviaFactsInput()),
    ...alternateInputs().map(buildTriviaFacts),
    buildLedgerTriviaFacts(fullLedgerInput()),
    buildDailyTriviaFacts(fullDailyInput()),
    buildDailyTriviaFacts(alternateDailyInput()),
    buildCalendarTriviaFacts(fullCalendarInput()),
    buildCalendarTriviaFacts(alternateCalendarInput()),
  ];
}

describe("trivia families", () => {
  it.each([...TRIVIA_FACT_IDS])("puts %s in exactly one family", (id) => {
    const owners = Object.values(TRIVIA_FAMILIES).filter((f) =>
      (f.ids as readonly string[]).includes(id),
    );
    expect(owners).toHaveLength(1);
    expect(TRIVIA_FAMILIES[familyOf(id)].ids).toContain(id);
  });

  it("lists no id that is not a fact id", () => {
    const all = Object.values(TRIVIA_FAMILIES).flatMap((f) => [...f.ids]);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...TRIVIA_FACT_IDS].sort());
  });

  it("puts the daily facts in the daily lane, the calendar moments in the event lane and the rest in evergreen", () => {
    const familiesOf = (facts: TriviaFact[]) =>
      facts.map((f) => familyOf(f.id));
    const daily = [
      ...familiesOf(buildDailyTriviaFacts(fullDailyInput())),
      ...familiesOf(buildDailyTriviaFacts(alternateDailyInput())),
    ];
    expect(new Set(daily).size).toBe(10);
    const event = [
      "activityAnniversary",
      "activityAccountAnniversary",
      "netWorthMilestone",
      "activityTransactionMilestone",
      "warrantiesExpiresSoon",
    ];
    // Every event family is produced by the calendar builder.
    const calendar = familiesOf(buildCalendarTriviaFacts(fullCalendarInput()));
    for (const family of event) expect(calendar).toContain(family);
    for (const family of Object.keys(TRIVIA_FAMILIES)) {
      const expected = daily.includes(family as TriviaFamily)
        ? "daily"
        : event.includes(family)
          ? "event"
          : "evergreen";
      expect({ family, lane: laneOf(family as TriviaFamily) }).toEqual({
        family,
        lane: expected,
      });
    }
  });

  it("makes every id producible from the fixtures", () => {
    const produced = new Set(
      builderOutputs()
        .flat()
        .map((f) => f.id),
    );
    expect([...produced].sort()).toEqual([...TRIVIA_FACT_IDS].sort());
  });

  it("yields at most one fact per family from a builder", () => {
    for (const facts of builderOutputs()) {
      const families = facts.map((f) => familyOf(f.id));
      expect(new Set(families).size).toBe(families.length);
    }
  });

  it("never shares a figure name between two families", () => {
    const owner = new Map<string, string>();
    for (const f of builderOutputs().flat()) {
      for (const name of Object.keys(f.figures)) {
        const family = familyOf(f.id);
        expect({ name, family: owner.get(name) ?? family }).toEqual({
          name,
          family,
        });
        owner.set(name, family);
      }
    }
  });

  it("gives every fact of one family one topic", () => {
    const topics = new Map<string, string>();
    for (const f of builderOutputs().flat()) {
      const family = familyOf(f.id);
      expect(topics.get(family) ?? f.topic).toBe(f.topic);
      topics.set(family, f.topic);
    }
  });
});
