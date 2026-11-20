import {
  fullCalendarInput,
  fullDailyInput,
  fullLedgerInput,
  fullRankedInput,
  fullTriviaFactsInput,
} from "./__fixtures__/trivia-pool.fixture";
import { buildCalendarTriviaFacts } from "./trivia-calendar-facts";
import { buildDailyTriviaFacts } from "./trivia-daily-facts";
import { familyOf, laneOf, type TriviaFamily } from "./trivia-families";
import { buildTriviaFacts } from "./trivia-facts";
import { buildLedgerTriviaFacts } from "./trivia-ledger-facts";
import { buildRankedTriviaFacts } from "./trivia-ranked-facts";
import {
  EVENT_PICKS,
  familyOrder,
  orderForDisplay,
  selectDailyTrivia,
  TOPIC_CAP,
  TRIVIA_DAILY_COUNT,
  yesterdayOf,
  type TriviaYesterday,
} from "./trivia-rotation";
import { addDaysYMD } from "../../common/date-utils";
import {
  TRIVIA_TOPICS,
  type TriviaFact,
  type TriviaFigures,
} from "./trivia.types";

const USER = "user-1";
const START = "2026-03-01";

const realPool = (): TriviaFact[] => [
  ...buildTriviaFacts(fullTriviaFactsInput()),
  ...buildLedgerTriviaFacts(fullLedgerInput()),
  ...buildRankedTriviaFacts(fullRankedInput()),
  ...buildDailyTriviaFacts(fullDailyInput()),
  ...buildCalendarTriviaFacts(fullCalendarInput()),
];

const lane = (f: TriviaFact) => laneOf(familyOf(f.id));
const families = (facts: TriviaFact[]) => facts.map((f) => familyOf(f.id));
const figuresOf = (facts: TriviaFact[]): TriviaFigures =>
  Object.assign({}, ...facts.map((f) => f.figures)) as TriviaFigures;
const asYesterday = (facts: TriviaFact[]): TriviaYesterday => ({
  families: new Set(families(facts)),
  figures: figuresOf(facts),
});
const topicCounts = (facts: TriviaFact[]) => {
  const counts = new Map<string, number>();
  for (const f of facts) counts.set(f.topic, (counts.get(f.topic) ?? 0) + 1);
  return counts;
};

/** Runs `days` consecutive days, feeding each output in as yesterday. */
function simulate(pool: TriviaFact[], days: number, poolOf = () => pool) {
  const out: TriviaFact[][] = [];
  let yesterday: TriviaYesterday | null = null;
  for (let i = 0; i < days; i++) {
    const picked = selectDailyTrivia(
      poolOf(),
      yesterday,
      USER,
      addDaysYMD(START, i),
    );
    out.push(picked);
    yesterday = asYesterday(picked);
  }
  return out;
}

describe("selectDailyTrivia", () => {
  const pool = realPool();
  const evergreen = pool.filter((f) => lane(f) === "evergreen");

  it("has a realistic pool to rotate", () => {
    expect(new Set(families(evergreen)).size).toBeGreaterThanOrEqual(20);
    expect(pool.some((f) => lane(f) === "daily")).toBe(true);
    expect(pool.some((f) => lane(f) === "event")).toBe(true);
  });

  it("is deterministic for the same user, day, pool and yesterday", () => {
    const yesterday = asYesterday(pool.slice(0, 5));
    const a = selectDailyTrivia(pool, yesterday, USER, START);
    const b = selectDailyTrivia([...pool], yesterday, USER, START);
    expect(b).toEqual(a);
  });

  it("gives different subsets on different days", () => {
    const keys = new Set(
      simulate(pool, 10).map((d) => families(d).sort().join(",")),
    );
    expect(keys.size).toBe(10);
  });

  it("gives different users different subsets", () => {
    const a = selectDailyTrivia(pool, null, "user-a", START);
    const b = selectDailyTrivia(pool, null, "user-b", START);
    expect(families(a)).not.toEqual(families(b));
  });

  it("returns at most one fact per family and TRIVIA_DAILY_COUNT in all", () => {
    for (const day of simulate(pool, 30)) {
      expect(day.length).toBeLessThanOrEqual(TRIVIA_DAILY_COUNT);
      expect(new Set(families(day)).size).toBe(day.length);
    }
  });

  it("never shows a family on two consecutive days when the pool allows", () => {
    const days = simulate(pool, 40);
    for (let i = 1; i < days.length; i++) {
      const before = new Set(families(days[i - 1]));
      expect(families(days[i]).filter((f) => before.has(f))).toEqual([]);
    }
  });

  it("respects the lane quotas on a full pool", () => {
    const [day] = simulate(pool, 1);
    expect(day.filter((f) => lane(f) === "event").length).toBeLessThanOrEqual(
      EVENT_PICKS,
    );
    expect(day).toHaveLength(TRIVIA_DAILY_COUNT);
  });

  it("holds every topic to the cap on every simulated day", () => {
    for (const day of simulate(pool, 60)) {
      for (const count of topicCounts(day).values()) {
        expect(count).toBeLessThanOrEqual(TOPIC_CAP);
      }
    }
  });

  it("fills from evergreen when the other lanes are short", () => {
    const day = selectDailyTrivia(evergreen, null, USER, START);
    expect(day).toHaveLength(TRIVIA_DAILY_COUNT);
    expect(day.every((f) => lane(f) === "evergreen")).toBe(true);
  });

  it("fills from events shown yesterday when nothing else is left", () => {
    const events = pool.filter((f) => lane(f) === "event");
    const yesterday = asYesterday(events);
    expect(selectDailyTrivia(events, yesterday, USER, START)).toHaveLength(
      events.length,
    );
  });

  it("returns the whole pool when it is smaller than a day, repeats and all", () => {
    const tiny = evergreen.slice(0, 3);
    const day = selectDailyTrivia(tiny, asYesterday(tiny), USER, START);
    expect(families(day).sort()).toEqual(families(tiny).sort());
    expect(selectDailyTrivia([], null, USER, START)).toEqual([]);
  });

  it("drops a second fact of one family", () => {
    const twice = [evergreen[0], { ...evergreen[0] }];
    expect(selectDailyTrivia(twice, null, USER, START)).toHaveLength(1);
  });

  it("shows every evergreen family within 30 days", () => {
    const shown = new Set(
      simulate(pool, 30).flatMap((d) =>
        d.filter((f) => lane(f) === "evergreen").map((f) => familyOf(f.id)),
      ),
    );
    const all = new Set(families(evergreen));
    expect([...all].filter((f) => !shown.has(f))).toEqual([]);
  });

  describe("the rotation step", () => {
    // Four events alternate, three daily facts move every day, so each day is
    // two events, four evergreen from the walk and two daily, with no fill.
    const topics = [...TRIVIA_TOPICS];
    const synthetic = (day: number): TriviaFact[] => {
      const evergreenFamilies = families(evergreen).filter(
        (f, i, all) => all.indexOf(f) === i,
      );
      const pick = (l: string) =>
        [...new Set(families(pool))].filter((f) => laneOf(f) === l);
      const make = (family: TriviaFamily, i: number): TriviaFact => {
        const id = pool.find((f) => familyOf(f.id) === family)!.id;
        return {
          id,
          topic: topics[i % topics.length],
          figures: { [`${family}Value`]: { kind: "count", value: day } },
        };
      };
      expect(evergreenFamilies.length).toBeGreaterThan(20);
      return [
        ...pick("event").slice(0, 4).map(make),
        ...pick("daily").slice(0, 3).map(make),
        ...evergreenFamilies.map(make),
      ];
    };

    it("never repeats an evergreen family within floor(E / 4) days", () => {
      const eligible = new Set(families(evergreen)).size;
      const span = Math.floor(eligible / 4);
      let n = 0;
      const days = simulate([], 40, () => synthetic(n++));
      const evergreenDays = days.map((d) =>
        families(d.filter((f) => lane(f) === "evergreen")),
      );
      for (let i = 0; i < evergreenDays.length; i++) {
        for (let j = i + 1; j < Math.min(i + span, evergreenDays.length); j++) {
          const overlap = evergreenDays[i].filter((f) =>
            evergreenDays[j].includes(f),
          );
          expect(overlap).toEqual([]);
        }
      }
    });
  });

  describe("the daily lane", () => {
    const base = realPool().find((f) => lane(f) === "daily")!;
    const evergreenPool = realPool().filter((f) => lane(f) === "evergreen");
    const fact = (value: number): TriviaFact => ({
      ...base,
      figures: Object.fromEntries(
        Object.entries(base.figures).map(([k, v]) => [
          k,
          v.kind === "money" ? { ...v, value } : v,
        ]),
      ),
    });
    const moneyFact = (): TriviaFact => {
      const f = fact(10);
      expect(Object.values(f.figures).some((v) => v.kind === "money")).toBe(
        true,
      );
      return f;
    };

    it("excludes a fact shown yesterday with identical figures", () => {
      const yesterday = asYesterday([moneyFact()]);
      const day = selectDailyTrivia(
        [moneyFact(), ...evergreenPool],
        yesterday,
        USER,
        START,
      );
      expect(day.map((f) => f.id)).not.toContain(moneyFact().id);
    });

    it("includes it again once a figure changed", () => {
      const yesterday = asYesterday([fact(10)]);
      const day = selectDailyTrivia(
        [fact(11), ...evergreenPool],
        yesterday,
        USER,
        START,
      );
      expect(day).toContainEqual(fact(11));
    });
  });

  describe("the event lane", () => {
    const events = realPool().filter((f) => lane(f) === "event");

    it("skips an event shown yesterday and shows it the day after", () => {
      expect(events.length).toBeGreaterThan(EVENT_PICKS);
      const day1 = selectDailyTrivia(events, null, USER, START);
      const day2 = selectDailyTrivia(
        events,
        asYesterday(day1),
        USER,
        addDaysYMD(START, 1),
      );
      expect(day1.slice(0, EVENT_PICKS).length).toBe(EVENT_PICKS);
      const first = new Set(families(day1.slice(0, EVENT_PICKS)));
      expect(
        families(day2.slice(0, EVENT_PICKS)).filter((f) => first.has(f)),
      ).toEqual([]);
    });

    it("shows a lone event on alternate days", () => {
      const lone = [events[0], ...pool.filter((f) => lane(f) !== "event")];
      const days = simulate(lone, 6);
      const has = days.map((d) => d.some((f) => f.id === events[0].id));
      expect(has).toEqual([true, false, true, false, true, false]);
    });
  });

  it("does not throw on a row from before this change", () => {
    const old = yesterdayOf({
      items: [
        { topic: "netWorth", source: "ai", text: "{x}" },
        { topic: "spending", source: "calculated", factId: "gone" as never },
      ],
      figures: {},
    });
    expect(old?.families.size).toBe(0);
    expect(() => selectDailyTrivia(pool, old, USER, START)).not.toThrow();
  });
});

describe("yesterdayOf", () => {
  it("is null without a row", () => {
    expect(yesterdayOf(null)).toBeNull();
  });

  it("reads calculated factIds and AI factIds, ignoring unknown ids", () => {
    const result = yesterdayOf({
      items: [
        {
          topic: "netWorth",
          source: "calculated",
          factId: "netWorthAtHighPoint",
        },
        {
          topic: "spending",
          source: "ai",
          text: "{a}",
          factIds: ["spendingLastDay", "nope" as never],
        },
      ],
      figures: { a: { kind: "count", value: 1 } },
    });
    expect([...(result?.families ?? [])].sort()).toEqual([
      "netWorthHighPoint",
      "spendingLastDay",
    ]);
    expect(result?.figures).toEqual({ a: { kind: "count", value: 1 } });
  });
});

describe("familyOrder", () => {
  it("is a permutation, stable for a user, spreading each topic", () => {
    const evergreen = realPool().filter((f) => lane(f) === "evergreen");
    const input = evergreen.map((f) => ({
      family: familyOf(f.id),
      topic: f.topic,
    }));
    const order = familyOrder(USER, input);
    expect(order.slice().sort()).toEqual(input.map((i) => i.family).sort());
    expect(familyOrder(USER, [...input].reverse())).toEqual(order);
    expect(familyOrder("user-2", input)).not.toEqual(order);
  });
});

describe("orderForDisplay", () => {
  const facts = realPool();

  it("is deterministic, keeps every fact and ignores the input order", () => {
    const a = orderForDisplay(facts, USER, START);
    expect(orderForDisplay([...facts].reverse(), USER, START)).toEqual(a);
    expect(a).toHaveLength(facts.length);
    expect(new Set(a)).toEqual(new Set(facts));
  });

  it("changes with the day", () => {
    expect(orderForDisplay(facts, USER, START)).not.toEqual(
      orderForDisplay(facts, USER, addDaysYMD(START, 1)),
    );
  });

  it("never puts two facts of one topic side by side when another order exists", () => {
    for (let i = 0; i < 20; i++) {
      const day = selectDailyTrivia(facts, null, USER, addDaysYMD(START, i));
      const ordered = orderForDisplay(day, USER, addDaysYMD(START, i));
      for (let j = 1; j < ordered.length; j++) {
        expect(ordered[j].topic).not.toBe(ordered[j - 1].topic);
      }
    }
  });

  it("falls back to a repeat only when one topic is all that is left", () => {
    const one = facts.filter((f) => f.topic === "netWorth").slice(0, 3);
    expect(orderForDisplay(one, USER, START)).toHaveLength(3);
  });
});
