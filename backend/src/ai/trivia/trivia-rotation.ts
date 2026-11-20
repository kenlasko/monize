import type { DashboardTrivia } from "../entities/dashboard-trivia.entity";
import { familyOf, laneOf, type TriviaFamily } from "./trivia-families";
import { dayIndex, seedHash } from "./trivia-windows";
import {
  TRIVIA_FACT_IDS,
  type TriviaFact,
  type TriviaFigure,
  type TriviaFigures,
  type TriviaTopic,
} from "./trivia.types";

/** About this many facts a day; a pool smaller than this is shown whole. */
export const TRIVIA_DAILY_COUNT = 8;
export const EVENT_PICKS = 2;
export const DAILY_PICKS = 3;
/** The rotation's step, constant so the evergreen cycle is stable. */
export const EVERGREEN_PICKS = 4;
export const TOPIC_CAP = 3;
/** The daily lane never puts more than this many facts of one topic in a day. */
const DAILY_TOPIC_CAP = 2;

/** What the stored row says was shown the day before. */
export interface TriviaYesterday {
  families: Set<TriviaFamily>;
  figures: TriviaFigures;
}

const KNOWN_IDS: ReadonlySet<string> = new Set(TRIVIA_FACT_IDS);

function isKnownId(id: unknown): id is (typeof TRIVIA_FACT_IDS)[number] {
  return typeof id === "string" && KNOWN_IDS.has(id);
}

/**
 * The families and figures of a stored row. An AI item without `factIds` (a
 * row from before the rotation) and an id the catalog no longer has
 * contribute nothing, so an old row never breaks the selection.
 */
export function yesterdayOf(
  row: Pick<DashboardTrivia, "items" | "figures"> | null,
): TriviaYesterday | null {
  if (!row) return null;
  const families = new Set<TriviaFamily>();
  for (const item of Array.isArray(row.items) ? row.items : []) {
    if (item?.source === "calculated") {
      if (isKnownId(item.factId)) families.add(familyOf(item.factId));
    } else if (item?.source === "ai" && Array.isArray(item.factIds)) {
      for (const id of item.factIds) {
        if (isKnownId(id)) families.add(familyOf(id));
      }
    }
  }
  return { families, figures: row.figures ?? {} };
}

/**
 * The cycle the evergreen rotation walks. Each topic's families are spread
 * evenly round it, so a run of consecutive entries is topic-balanced without
 * skipping any family.
 */
export function familyOrder(
  userId: string,
  families: { family: TriviaFamily; topic: TriviaTopic }[],
): TriviaFamily[] {
  const byTopic = new Map<TriviaTopic, TriviaFamily[]>();
  for (const { family, topic } of families) {
    byTopic.set(topic, [...(byTopic.get(topic) ?? []), family]);
  }
  const keyed: { family: TriviaFamily; key: number; hash: number }[] = [];
  for (const [topic, members] of byTopic) {
    const sorted = members
      .map((family) => ({ family, hash: seedHash(userId, family) }))
      .sort((a, b) => a.hash - b.hash || a.family.localeCompare(b.family));
    const offset = seedHash(userId, "topic", topic) / 2 ** 32;
    sorted.forEach(({ family, hash }, i) => {
      keyed.push({ family, hash, key: (i + offset) / sorted.length });
    });
  }
  return keyed
    .sort(
      (a, b) =>
        a.key - b.key || a.hash - b.hash || a.family.localeCompare(b.family),
    )
    .map((k) => k.family);
}

function sameFigure(a: TriviaFigure | undefined, b: TriviaFigure): boolean {
  if (!a || a.kind !== b.kind || a.value !== b.value) return false;
  const currencyOf = (f: TriviaFigure) =>
    f.kind === "money" ? f.currency : "";
  return currencyOf(a) === currencyOf(b);
}

/** Some figure of the fact differs from yesterday's figure of the same name. */
function changedSince(fact: TriviaFact, yesterday: TriviaYesterday): boolean {
  return Object.entries(fact.figures).some(
    ([name, figure]) => !sameFigure(yesterday.figures[name], figure),
  );
}

/**
 * The day's subset of the pool, pure: the same user, day, pool and yesterday
 * always give the same facts, at most one per family.
 *
 * Events not shown yesterday come first (so a week-long anniversary shows on
 * alternate days), then the daily facts that are new or moved, then the
 * evergreen families the rotation has reached. Short lanes are filled up to
 * `TRIVIA_DAILY_COUNT`, no topic goes past `TOPIC_CAP` while another is
 * available, and no family shown yesterday returns today unless the pool is
 * too small to avoid it.
 */
export function selectDailyTrivia(
  pool: TriviaFact[],
  yesterday: TriviaYesterday | null,
  userId: string,
  today: string,
): TriviaFact[] {
  const day = dayIndex(today);
  const shownBefore = yesterday?.families ?? new Set<TriviaFamily>();

  // One fact per family: the first the pool offers.
  const byFamily = new Map<TriviaFamily, TriviaFact>();
  for (const fact of pool) {
    const family = familyOf(fact.id);
    if (!byFamily.has(family)) byFamily.set(family, fact);
  }
  const laneFacts = (lane: ReturnType<typeof laneOf>) =>
    [...byFamily.entries()]
      .filter(([family]) => laneOf(family) === lane)
      .map(([family, fact]) => ({ family, fact }));

  const chosen: { family: TriviaFamily; fact: TriviaFact }[] = [];
  const topicCount = new Map<TriviaTopic, number>();
  const taken = new Set<TriviaFamily>();
  const room = () => TRIVIA_DAILY_COUNT - chosen.length;
  const add = (entry: { family: TriviaFamily; fact: TriviaFact }) => {
    chosen.push(entry);
    taken.add(entry.family);
    topicCount.set(
      entry.fact.topic,
      (topicCount.get(entry.fact.topic) ?? 0) + 1,
    );
  };
  const underCap = (topic: TriviaTopic, cap = TOPIC_CAP) =>
    (topicCount.get(topic) ?? 0) < cap;
  const tie = (family: TriviaFamily) => seedHash(userId, String(day), family);

  // Events: never dropped by the topic cap.
  const events = laneFacts("event")
    .filter((e) => !shownBefore.has(e.family))
    .sort((a, b) => tie(a.family) - tie(b.family));
  events.slice(0, EVENT_PICKS).forEach(add);

  // Daily: a fact new today, or one that moved, outranks one that did not.
  const dailyScored = laneFacts("daily")
    .filter(
      (d) =>
        !shownBefore.has(d.family) ||
        (yesterday !== null && changedSince(d.fact, yesterday)),
    )
    .map((d) => ({
      ...d,
      score:
        (shownBefore.has(d.family) ? 0 : 2) +
        (yesterday !== null && changedSince(d.fact, yesterday) ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score || tie(a.family) - tie(b.family));
  const dailyTopics = new Map<TriviaTopic, number>();
  const takeDaily = (limit: number) => {
    let added = 0;
    for (const d of dailyScored) {
      if (added >= limit || room() <= 0) break;
      if (taken.has(d.family) || !underCap(d.fact.topic)) continue;
      if ((dailyTopics.get(d.fact.topic) ?? 0) >= DAILY_TOPIC_CAP) continue;
      dailyTopics.set(d.fact.topic, (dailyTopics.get(d.fact.topic) ?? 0) + 1);
      add(d);
      added++;
    }
  };
  // Evergreen: walk the cycle from today's start, past yesterday's families.
  const evergreen = laneFacts("evergreen");
  const cycle = familyOrder(
    userId,
    evergreen.map((e) => ({ family: e.family, topic: e.fact.topic })),
  );
  const walk =
    cycle.length === 0
      ? []
      : [
          ...cycle.slice((day * EVERGREEN_PICKS) % cycle.length),
          ...cycle,
        ].slice(0, cycle.length);
  const walkEntries = walk.map((family) => ({
    family,
    fact: byFamily.get(family) as TriviaFact,
  }));
  const takeWalk = (limit: number) => {
    let added = 0;
    for (const e of walkEntries) {
      if (added >= limit || room() <= 0) break;
      if (taken.has(e.family) || shownBefore.has(e.family)) continue;
      if (!underCap(e.fact.topic)) continue;
      add(e);
      added++;
    }
  };
  // The rotation takes its full step before the daily facts: the walk advances
  // by EVERGREEN_PICKS a day, so a day that took fewer would starve the
  // families it passed over for good. A crowded day trims a daily fact instead.
  takeWalk(Math.min(EVERGREEN_PICKS, room()));
  takeDaily(DAILY_PICKS);

  // Fill: the evergreen walk on, the unused daily facts, then events shown yesterday.
  takeWalk(room());
  takeDaily(room());
  for (const e of laneFacts("event").sort(
    (a, b) => tie(a.family) - tie(b.family),
  )) {
    if (room() <= 0) break;
    if (!taken.has(e.family)) add(e);
  }

  // A pool too small to avoid a repeat or a topic still shows everything it has.
  if (room() > 0 && byFamily.size <= TRIVIA_DAILY_COUNT) {
    for (const entry of [
      ...dailyScored,
      ...events,
      ...laneFacts("event"),
      ...walkEntries,
      ...laneFacts("daily"),
    ]) {
      if (room() <= 0) break;
      if (!taken.has(entry.family)) add(entry);
    }
  }
  return chosen.map((c) => c.fact);
}

/**
 * A fixed order for the day with no two facts of one topic side by side while
 * another order exists. Facts start in a hash order; each step takes the first
 * fact of the topic with the most facts left (other than the previous topic),
 * which finds a spread whenever one exists. It replaces the random shuffle, so
 * a reload and the daily job agree.
 */
export function orderForDisplay(
  facts: TriviaFact[],
  userId: string,
  today: string,
): TriviaFact[] {
  const day = String(dayIndex(today));
  const remaining = [...facts].sort(
    (a, b) =>
      seedHash(userId, day, a.id) - seedHash(userId, day, b.id) ||
      a.id.localeCompare(b.id),
  );
  const ordered: TriviaFact[] = [];
  while (remaining.length > 0) {
    const previous = ordered[ordered.length - 1]?.topic;
    const left = (topic: TriviaTopic) =>
      remaining.filter((f) => f.topic === topic).length;
    let best = -1;
    remaining.forEach((f, i) => {
      if (f.topic === previous) return;
      if (best === -1 || left(f.topic) > left(remaining[best].topic)) best = i;
    });
    ordered.push(...remaining.splice(best === -1 ? 0 : best, 1));
  }
  return ordered;
}
