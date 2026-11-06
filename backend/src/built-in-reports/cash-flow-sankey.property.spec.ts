import {
  assembleCashFlowSankey,
  SankeyCategorizedRow,
  SankeyCategory,
  SankeyTransferRow,
} from "./cash-flow-sankey-assembly";
import type { CashFlowSankeyResponse } from "./dto";

/**
 * SANKEY-001 and SANKEY-002 over generated ledgers.
 *
 * A seeded generator builds a ledger over every account type: categorized rows
 * of both signs (some split, some uncategorized), transfers in both directions
 * (some as a split's transfer line), VOID rows and investment-linked cash. A
 * selector reads it the way the three queries of `cash-flow-sankey.service.ts`
 * do -- own account in scope, counterpart out of scope, VOID and investment
 * linkage excluded -- and the assembly turns the rows into a response.
 *
 * What is asserted is computed from the LEDGER, not from the selected rows: the
 * closing identity in integer ten-thousandths, and that a transfer contributes
 * its amount once when exactly one side is in scope and nothing when both are,
 * whichever leg the selector happened to read. That the SQL selects as the
 * selector does is the integration suite's proof
 * (`test/integration/cash-flow-sankey.integration.spec.ts`).
 */

const LEDGERS = 200;
const CURRENCY = "CAD";
const ACCOUNT_TYPES = [
  "CHEQUING",
  "SAVINGS",
  "CASH",
  "CREDIT_CARD",
  "LINE_OF_CREDIT",
  "LOAN",
  "MORTGAGE",
  "INVESTMENT",
  "ASSET",
  "OTHER",
  "CRYPTO",
];

/** mulberry32: small, seeded, and the same sequence on every machine. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface LedgerAccount {
  id: string;
  type: string;
}

/** One categorized line: a whole row, or one line of a split. */
interface LedgerLine {
  accountId: string;
  categoryId: string | null;
  /** Ten-thousandths. */
  minor: number;
  void: boolean;
  investmentLinked: boolean;
  date: string;
}

/** A transfer: two legs, one economic fact, sharing a status. */
interface LedgerTransfer {
  fromId: string;
  toId: string;
  minor: number;
  void: boolean;
  investmentLinked: boolean;
  /** The source side is a split's transfer line rather than a whole row. */
  fromSplit: boolean;
  date: string;
}

interface Ledger {
  accounts: LedgerAccount[];
  categories: SankeyCategory[];
  lines: LedgerLine[];
  transfers: LedgerTransfer[];
  scope: Set<string>;
}

function generate(seed: number): Ledger {
  const random = prng(seed);
  const pick = <T>(items: readonly T[]): T =>
    items[Math.floor(random() * items.length)];
  const amount = () => Math.round(random() * 500_0000) + 1;
  const date = () =>
    `2026-09-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}`;

  const accounts: LedgerAccount[] = Array.from(
    { length: 2 + Math.floor(random() * 6) },
    (_, i) => ({ id: `acc-${i}`, type: pick(ACCOUNT_TYPES) }),
  );
  const roots: SankeyCategory[] = Array.from({ length: 4 }, (_, i) => ({
    id: `cat-${i}`,
    name: `Category ${i}`,
    parentId: null,
    color: null,
    isIncome: random() < 0.4,
  }));
  const children: SankeyCategory[] = roots.flatMap((root, i) =>
    random() < 0.5
      ? [
          {
            id: `cat-${i}-child`,
            name: `Child ${i}`,
            parentId: root.id,
            color: null,
            isIncome: random() < 0.3,
          },
        ]
      : [],
  );
  const categories = [...roots, ...children];
  const categoryIds = [...categories.map((c) => c.id), null];

  const lines: LedgerLine[] = Array.from(
    { length: Math.floor(random() * 25) },
    () => ({
      accountId: pick(accounts).id,
      categoryId: pick(categoryIds),
      minor: (random() < 0.5 ? -1 : 1) * amount(),
      void: random() < 0.1,
      investmentLinked: random() < 0.1,
      date: date(),
    }),
  );

  const transfers: LedgerTransfer[] = [];
  for (let i = 0; i < Math.floor(random() * 12); i += 1) {
    const from = pick(accounts);
    const to = pick(accounts.filter((a) => a.id !== from.id));
    transfers.push({
      fromId: from.id,
      toId: to.id,
      minor: amount(),
      void: random() < 0.1,
      investmentLinked: random() < 0.1,
      fromSplit: random() < 0.3,
      date: date(),
    });
  }

  const scope = new Set(accounts.filter(() => random() < 0.5).map((a) => a.id));
  if (scope.size === 0) scope.add(accounts[0].id);

  return { accounts, categories, lines, transfers, scope };
}

/**
 * The three queries, as predicates over the ledger: the categorized query reads
 * in-scope lines; each transfer query reads a leg whose own account is in scope
 * and whose counterpart is not. VOID and investment linkage are out of all
 * three.
 */
function select(ledger: Ledger): {
  categorized: SankeyCategorizedRow[];
  transfers: SankeyTransferRow[];
} {
  const typeOf = new Map(ledger.accounts.map((a) => [a.id, a.type]));
  const categorized = ledger.lines
    .filter(
      (l) => ledger.scope.has(l.accountId) && !l.void && !l.investmentLinked,
    )
    .map((l) => ({
      categoryId: l.categoryId,
      currency: CURRENCY,
      date: l.date,
      ownRate: null,
      positive: l.minor > 0 ? l.minor / 10000 : 0,
      negative: l.minor < 0 ? l.minor / 10000 : 0,
    }));

  const transfers: SankeyTransferRow[] = [];
  for (const t of ledger.transfers) {
    if (t.void || t.investmentLinked) continue;
    const legs: Array<{ own: string; counterpart: string; minor: number }> = [
      { own: t.fromId, counterpart: t.toId, minor: -t.minor },
      { own: t.toId, counterpart: t.fromId, minor: t.minor },
    ];
    for (const leg of legs) {
      if (!ledger.scope.has(leg.own) || ledger.scope.has(leg.counterpart)) {
        continue;
      }
      transfers.push({
        counterpartAccountId: leg.counterpart,
        counterpartType: typeOf.get(leg.counterpart) ?? null,
        counterpartName: leg.counterpart,
        currency: CURRENCY,
        date: t.date,
        ownRate: null,
        inflow: leg.minor > 0 ? leg.minor / 10000 : 0,
        outflow: leg.minor < 0 ? leg.minor / 10000 : 0,
      });
    }
  }
  return { categorized, transfers };
}

function assemble(ledger: Ledger, depth: 1 | 2 = 1): CashFlowSankeyResponse {
  const { categorized, transfers } = select(ledger);
  return assembleCashFlowSankey({
    startDate: "2026-09-01",
    endDate: "2026-09-30",
    currency: CURRENCY,
    scopeAccountIds: [...ledger.scope],
    depth,
    categories: ledger.categories,
    categorized,
    transfers,
    convert: (value) => value,
  });
}

const minor = (value: number | null): number => {
  if (value === null) throw new Error("expected a complete figure");
  return Math.round(value * 10000);
};

/** What the transfers moved across the scope boundary, from the ledger. */
function boundaryFlows(ledger: Ledger): { inflows: number; outflows: number } {
  let inflows = 0;
  let outflows = 0;
  for (const t of ledger.transfers) {
    if (t.void || t.investmentLinked) continue;
    const fromIn = ledger.scope.has(t.fromId);
    const toIn = ledger.scope.has(t.toId);
    if (fromIn && !toIn) outflows += t.minor;
    if (toIn && !fromIn) inflows += t.minor;
  }
  return { inflows, outflows };
}

describe("Cash Flow Sankey over generated ledgers", () => {
  const seeds = Array.from({ length: LEDGERS }, (_, i) => 1490 + i * 7919);

  it("closes every diagram: income + inflows + deficit = expenses + outflows + unspent (SANKEY-001)", () => {
    for (const seed of seeds) {
      for (const depth of [1, 2] as const) {
        const result = assemble(generate(seed), depth);
        const t = result.totals;
        const left = minor(t.income) + minor(t.inflows) + minor(t.deficit);
        const right = minor(t.expenses) + minor(t.outflows) + minor(t.unspent);
        expect({ seed, depth, diff: left - right }).toEqual({
          seed,
          depth,
          diff: 0,
        });
        // At most one residual is non-zero.
        expect(minor(t.unspent) > 0 && minor(t.deficit) > 0).toBe(false);
        // The hub's links carry the same identity.
        const into = result.links
          .filter((l) => l.target === "hub")
          .reduce((s, l) => s + minor(l.amount), 0);
        const out = result.links
          .filter((l) => l.source === "hub")
          .reduce((s, l) => s + minor(l.amount), 0);
        expect(into).toBe(left);
        expect(out).toBe(right);
      }
    }
  });

  it("nets the categorized rows to what the ledger says they moved", () => {
    for (const seed of seeds) {
      const ledger = generate(seed);
      const result = assemble(ledger);
      const expected = ledger.lines
        .filter(
          (l) =>
            ledger.scope.has(l.accountId) && !l.void && !l.investmentLinked,
        )
        .reduce((s, l) => s + l.minor, 0);
      const t = result.totals;
      expect({ seed, net: minor(t.income) - minor(t.expenses) }).toEqual({
        seed,
        net: expected,
      });
    }
  });

  it("counts a transfer once when one side is in scope and never when both are (SANKEY-002)", () => {
    for (const seed of seeds) {
      const ledger = generate(seed);
      const result = assemble(ledger);
      const { inflows, outflows } = boundaryFlows(ledger);
      expect({ seed, inflows: minor(result.totals.inflows) }).toEqual({
        seed,
        inflows,
      });
      expect({ seed, outflows: minor(result.totals.outflows) }).toEqual({
        seed,
        outflows,
      });
    }
  });

  it("makes a transfer internal, not doubled, when its counterpart joins the scope", () => {
    for (const seed of seeds) {
      const ledger = generate(seed);
      const crossing = ledger.transfers.find(
        (t) =>
          !t.void &&
          !t.investmentLinked &&
          ledger.scope.has(t.fromId) &&
          !ledger.scope.has(t.toId),
      );
      if (!crossing) continue;

      const widened: Ledger = {
        ...ledger,
        scope: new Set([...ledger.scope, crossing.toId]),
      };
      const before = assemble(ledger);
      const after = assemble(widened);
      const { inflows, outflows } = boundaryFlows(widened);

      expect(minor(after.totals.outflows)).toBe(outflows);
      expect(minor(after.totals.inflows)).toBe(inflows);
      // The now-internal transfer contributes nothing on either side: the
      // widened answer is the one the ledger gives without it at all.
      const without = assemble({
        ...widened,
        transfers: widened.transfers.filter((t) => t !== crossing),
      });
      expect(minor(after.totals.outflows)).toBe(minor(without.totals.outflows));
      expect(minor(after.totals.inflows)).toBe(minor(without.totals.inflows));
      // Before widening it was counted, once, as an outflow.
      expect(minor(before.totals.outflows)).toBeGreaterThanOrEqual(
        crossing.minor,
      );
    }
  });

  it("withholds the totals and the residual while a link cannot convert (SANKEY-004)", () => {
    for (const seed of seeds.slice(0, 40)) {
      const ledger = generate(seed);
      const { categorized, transfers } = select(ledger);
      if (categorized.length === 0) continue;
      const foreign = categorized.map((row, i) =>
        i === 0 ? { ...row, currency: "USD" } : row,
      );
      const result = assembleCashFlowSankey({
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        currency: CURRENCY,
        scopeAccountIds: [...ledger.scope],
        depth: 1,
        categories: ledger.categories,
        categorized: foreign,
        transfers,
        convert: (value, from) => (from === CURRENCY ? value : null),
      });
      const first = foreign[0];
      if (first.positive === 0 && first.negative === 0) continue;

      expect(result.missingCurrencies).toEqual(["USD"]);
      expect(result.excludedCount).toBe(1);
      expect(result.totals.unspent).toBeNull();
      expect(result.totals.deficit).toBeNull();
      expect(
        result.totals.income === null || result.totals.expenses === null,
      ).toBe(true);
    }
  });
});
