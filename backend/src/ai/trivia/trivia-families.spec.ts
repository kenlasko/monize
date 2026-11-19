import {
  alternateInputs,
  fullLedgerInput,
  fullTriviaFactsInput,
} from "./__fixtures__/trivia-pool.fixture";
import { buildTriviaFacts } from "./trivia-facts";
import { buildLedgerTriviaFacts } from "./trivia-ledger-facts";
import { familyOf, laneOf, TRIVIA_FAMILIES } from "./trivia-families";
import { TRIVIA_FACT_IDS, type TriviaFact } from "./trivia.types";

/** Every fact a builder can produce from the fixtures, one list per builder. */
function builderOutputs(): TriviaFact[][] {
  return [
    buildTriviaFacts(fullTriviaFactsInput()),
    ...alternateInputs().map(buildTriviaFacts),
    buildLedgerTriviaFacts(fullLedgerInput()),
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

  it("keeps every family evergreen in this phase", () => {
    for (const family of Object.keys(TRIVIA_FAMILIES)) {
      expect(laneOf(family as keyof typeof TRIVIA_FAMILIES)).toBe("evergreen");
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
