/**
 * The Cash Flow Sankey's arithmetic, apart from its SQL: the rows
 * `CashFlowSankeyService` selects go in, the response of
 * `docs/specs/sankey-cash-flow.md` section 6 comes out.
 *
 * Kept pure so the closing identity (SANKEY-001) and the once-per-leg rule
 * (SANKEY-002) can be exercised over generated ledgers without a database
 * (`cash-flow-sankey.property.spec.ts`); which rows reach this module is the
 * SQL's job and the integration suite's proof.
 */
import { FxAggregate } from "../common/fx-aggregate";
import type {
  CashFlowSankeyLink,
  CashFlowSankeyNode,
  CashFlowSankeyResponse,
  SankeyDepth,
  SankeyNodeKind,
} from "./dto/cash-flow-sankey.dto";

/** Integer ten-thousandths, the resolution of `decimal(20,4)`. */
const SCALE = 10000;

const toMinor = (value: number): number => Math.round(value * SCALE);
/** `-0` is not a figure anyone should read, so it leaves as `0`. */
const fromMinor = (minor: number): number => (minor === 0 ? 0 : minor / SCALE);

/**
 * Categorized, non-transfer rows of in-scope accounts, one per
 * (category, currency, date, own rate). `positive` and `negative` are the two
 * signed halves of the group, so a category can be netted while an
 * uncategorized row keeps its own side (decision 8).
 */
export interface SankeyCategorizedRow {
  categoryId: string | null;
  currency: string;
  date: string;
  ownRate: number | null;
  positive: number;
  negative: number;
}

/**
 * Transfer legs whose own account is in scope and whose counterpart is not,
 * grouped by counterpart. `inflow` is the positive half, `outflow` the
 * negative half (still signed). A `null` counterpart is a leg whose other side
 * was deleted (design section 9).
 */
export interface SankeyTransferRow {
  counterpartAccountId: string | null;
  counterpartType: string | null;
  counterpartManagedPurpose?: string | null;
  counterpartName: string | null;
  currency: string;
  date: string;
  ownRate: number | null;
  inflow: number;
  outflow: number;
}

export interface SankeyCategory {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  isIncome: boolean;
}

/**
 * Converts a signed amount in `currency` on `date` into the reporting currency,
 * or answers `null` when no admissible rate exists. Supplied by the caller so
 * the rate policy stays `resolveFxRate`'s (INV-FX-001) and a row's own rate
 * wins where it reaches (INV-FX-002).
 */
export type SankeyConverter = (
  amount: number,
  currency: string,
  date: string,
  ownRate: number | null,
) => number | null;

export interface SankeyAssemblyInput {
  startDate: string;
  endDate: string;
  currency: string;
  scopeAccountIds: string[];
  depth: SankeyDepth;
  categories: SankeyCategory[];
  categorized: SankeyCategorizedRow[];
  transfers: SankeyTransferRow[];
  convert: SankeyConverter;
}

/** Destination classes, by the counterpart account's type (decision 3). */
export type SankeyFlowClass =
  "savings" | "debt" | "other_accounts" | "shared_settlements";

const SAVINGS_TYPES = new Set(["SAVINGS", "INVESTMENT", "ASSET", "OTHER"]);
const DEBT_TYPES = new Set(["LOAN", "MORTGAGE", "LINE_OF_CREDIT"]);

/**
 * The class a counterpart's type decides. A credit card is "other accounts",
 * never debt: the spending it settles was already an expense on the purchase
 * date (decision 5). A counterpart this reader cannot see is "other accounts"
 * so the identity still closes (section 9).
 */
export function classifyCounterpart(
  type: string | null,
  managedPurpose?: string | null,
): SankeyFlowClass {
  if (managedPurpose === "SHARED_SETTLEMENT") return "shared_settlements";
  if (type && SAVINGS_TYPES.has(type)) return "savings";
  if (type && DEBT_TYPES.has(type)) return "debt";
  return "other_accounts";
}

const INFLOW_ID: Record<SankeyFlowClass, string> = {
  shared_settlements: "inflow:shared_settlements",
  savings: "inflow:savings",
  debt: "inflow:borrowed",
  other_accounts: "inflow:other_accounts",
};

/**
 * English fallbacks for the nodes that are not a category or an account. The
 * client labels these from its own catalog by id.
 */
export const SANKEY_FIXED_LABELS: Record<string, string> = {
  hub: "Income",
  "class:shared_settlements": "Shared settlements",
  "inflow:shared_settlements": "From shared settlements",
  "class:savings": "Savings & investments",
  "class:debt": "Debt payments",
  "class:other_accounts": "Other accounts",
  "inflow:savings": "From savings & investments",
  "inflow:borrowed": "Borrowed",
  "inflow:other_accounts": "From other accounts",
  "uncategorized:income": "Uncategorized income",
  "uncategorized:expense": "Uncategorized expenses",
  "residual:unspent": "Unspent",
  "residual:deficit": "Drawn from balances",
  "account:unlinked": "(unlinked account)",
};

export const SANKEY_NO_SUBCATEGORY_LABEL = "(no subcategory)";

/** A response whose diagram does not close (SANKEY-001). Never drawn. */
export class SankeyIdentityError extends Error {
  constructor(
    message: string,
    readonly discrepancyMinor: number,
  ) {
    super(message);
    this.name = "SankeyIdentityError";
  }
}

interface Bucket {
  agg: FxAggregate;
}

/** A link before rounding: its known part and whether anything is missing. */
interface DraftLink {
  source: string;
  target: string;
  knownMinor: number;
  complete: boolean;
}

interface DraftNode {
  id: string;
  kind: SankeyNodeKind;
  label: string;
  categoryId: string | null;
  parentCategoryId: string | null;
  accountId: string | null;
  color: string | null;
  knownMinor: number;
  complete: boolean;
}

function bucketOf<K>(map: Map<K, Bucket>, key: K): Bucket {
  const existing = map.get(key);
  if (existing) return existing;
  const created = { agg: new FxAggregate() };
  map.set(key, created);
  return created;
}

/**
 * The category tree, walked to the top-level ancestor and to the ancestor one
 * level below it. A cycle (which the schema does not forbid) stops the walk at
 * the first repeat rather than spinning.
 */
function categoryPath(
  id: string,
  byId: Map<string, SankeyCategory>,
): SankeyCategory[] {
  const path: SankeyCategory[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    path.unshift(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

export function assembleCashFlowSankey(
  input: SankeyAssemblyInput,
): CashFlowSankeyResponse {
  const { currency, convert, depth } = input;
  const byId = new Map(input.categories.map((c) => [c.id, c]));

  const missingCurrencies = new Set<string>();
  let excludedCount = 0;

  /** Signed (positive = money in) per top-level category. */
  const roots = new Map<string, Bucket>();
  /** Signed per (root, second-level category), for depth 2. */
  const children = new Map<string, Map<string, Bucket>>();
  const uncategorizedIncome = new FxAggregate();
  const uncategorizedExpense = new FxAggregate();

  /** Positive magnitudes per outflow class and per inflow class. */
  const outflowClasses = new Map<SankeyFlowClass, Bucket>();
  const inflowClasses = new Map<SankeyFlowClass, Bucket>();
  /** Positive magnitudes per (outflow class, counterpart account). */
  const classAccounts = new Map<
    SankeyFlowClass,
    Map<string, { bucket: Bucket; name: string | null }>
  >();

  const convertHalf = (
    amount: number,
    row: { currency: string; date: string; ownRate: number | null },
  ): { value: number | null; needed: boolean } => {
    // Zero needs no rate, so it never makes a figure unknown.
    if (amount === 0) return { value: 0, needed: false };
    return {
      value: convert(amount, row.currency, row.date, row.ownRate),
      needed: true,
    };
  };

  for (const row of input.categorized) {
    const pos = convertHalf(row.positive, row);
    const neg = convertHalf(row.negative, row);
    if (
      (pos.needed && pos.value === null) ||
      (neg.needed && neg.value === null)
    ) {
      missingCurrencies.add(row.currency);
      excludedCount += 1;
    }

    const path = row.categoryId ? categoryPath(row.categoryId, byId) : [];
    if (path.length === 0) {
      // No category, or one this user cannot see: uncategorized, each sign on
      // its own side (decision 8).
      if (pos.needed)
        uncategorizedIncome.add(pos.value, row.currency, currency);
      if (neg.needed) {
        uncategorizedExpense.add(
          neg.value === null ? null : -neg.value,
          row.currency,
          currency,
        );
      }
      continue;
    }

    const root = path[0];
    const second = path.length > 1 ? path[1] : root;
    const rootBucket = bucketOf(roots, root.id);
    let childMap = children.get(root.id);
    if (!childMap) {
      childMap = new Map();
      children.set(root.id, childMap);
    }
    const childBucket = bucketOf(childMap, second.id);
    for (const half of [pos, neg]) {
      if (!half.needed) continue;
      rootBucket.agg.add(half.value, row.currency, currency);
      childBucket.agg.add(half.value, row.currency, currency);
    }
  }

  for (const row of input.transfers) {
    const flowClass = classifyCounterpart(
      row.counterpartType,
      row.counterpartManagedPurpose,
    );
    const inflow = convertHalf(row.inflow, row);
    const outflow = convertHalf(row.outflow, row);
    if (
      (inflow.needed && inflow.value === null) ||
      (outflow.needed && outflow.value === null)
    ) {
      missingCurrencies.add(row.currency);
      excludedCount += 1;
    }
    if (inflow.needed) {
      bucketOf(inflowClasses, flowClass).agg.add(
        inflow.value,
        row.currency,
        currency,
      );
    }
    if (outflow.needed) {
      const magnitude = outflow.value === null ? null : -outflow.value;
      bucketOf(outflowClasses, flowClass).agg.add(
        magnitude,
        row.currency,
        currency,
      );
      let accounts = classAccounts.get(flowClass);
      if (!accounts) {
        accounts = new Map();
        classAccounts.set(flowClass, accounts);
      }
      const key = row.counterpartAccountId ?? "unlinked";
      let entry = accounts.get(key);
      if (!entry) {
        entry = {
          bucket: { agg: new FxAggregate() },
          name: row.counterpartName,
        };
        accounts.set(key, entry);
      }
      entry.bucket.agg.add(magnitude, row.currency, currency);
    }
  }

  const nodes: DraftNode[] = [];
  const links: DraftLink[] = [];

  const sideTotals = {
    income: { minor: 0, complete: true },
    inflows: { minor: 0, complete: true },
    expenses: { minor: 0, complete: true },
    outflows: { minor: 0, complete: true },
  };
  type Side = keyof typeof sideTotals;
  const addToSide = (side: Side, minor: number, complete: boolean) => {
    sideTotals[side].minor += minor;
    if (!complete) sideTotals[side].complete = false;
  };

  const pushNode = (node: DraftNode) => nodes.push(node);
  const pushLink = (link: DraftLink) => {
    // A known zero moves nothing and is not drawn; an unknown one still is.
    if (link.complete && link.knownMinor === 0) return;
    links.push(link);
  };

  // ---- Categories: one node per top-level category, on the side it nets to.
  const rootEntries = [...roots.entries()];
  for (const [rootId, bucket] of rootEntries) {
    const category = byId.get(rootId)!;
    const signedMinor = toMinor(bucket.agg.knownSubtotal);
    const complete = bucket.agg.isComplete;
    // A complete category sits where it nets (the isNetSpending rule, both
    // ways); one whose net is unknown sits where its own type says, since the
    // sign that would move it is the figure that is missing.
    const isIncomeSide = complete
      ? signedMinor > 0 || (signedMinor === 0 && category.isIncome)
      : category.isIncome;
    const kind: SankeyNodeKind = isIncomeSide ? "income" : "expense";
    const id = `${kind}:${rootId}`;
    const knownMinor = isIncomeSide ? signedMinor : -signedMinor;
    pushNode({
      id,
      kind,
      label: category.name,
      categoryId: rootId,
      parentCategoryId: null,
      accountId: null,
      color: category.color,
      knownMinor,
      complete,
    });
    if (isIncomeSide) {
      addToSide("income", knownMinor, complete);
      pushLink({ source: id, target: "hub", knownMinor, complete });
      continue;
    }
    addToSide("expenses", knownMinor, complete);
    pushLink({ source: "hub", target: id, knownMinor, complete });

    if (depth !== 2) continue;
    const childMap = children.get(rootId)!;
    const hasSubcategory = [...childMap.keys()].some((key) => key !== rootId);
    if (!hasSubcategory) continue;
    for (const [childId, childBucket] of childMap) {
      const child = byId.get(childId)!;
      const childSigned = toMinor(childBucket.agg.knownSubtotal);
      const childComplete = childBucket.agg.isComplete;
      // In the parent's direction: what the child spent.
      const spentMinor = -childSigned;
      const nodeId = `child:${childId}`;
      pushNode({
        id: nodeId,
        kind: "child",
        label: childId === rootId ? SANKEY_NO_SUBCATEGORY_LABEL : child.name,
        categoryId: childId,
        parentCategoryId: rootId,
        accountId: null,
        color: child.color ?? category.color,
        knownMinor: Math.abs(spentMinor),
        complete: childComplete,
      });
      // A subcategory that nets the other way (refunds beyond spending) flows
      // INTO its parent, so the parent's node still balances and the child
      // links, signed, sum to the parent's link.
      if (childComplete && spentMinor < 0) {
        pushLink({
          source: nodeId,
          target: id,
          knownMinor: -spentMinor,
          complete: true,
        });
      } else {
        pushLink({
          source: id,
          target: nodeId,
          knownMinor: spentMinor,
          complete: childComplete,
        });
      }
    }
  }

  // ---- Uncategorized, each sign on its own side.
  const uncategorized: Array<[FxAggregate, "income" | "expense"]> = [
    [uncategorizedIncome, "income"],
    [uncategorizedExpense, "expense"],
  ];
  for (const [agg, side] of uncategorized) {
    const knownMinor = toMinor(agg.knownSubtotal);
    if (agg.isComplete && knownMinor === 0) continue;
    const id = `uncategorized:${side}`;
    pushNode({
      id,
      kind: "uncategorized",
      label: SANKEY_FIXED_LABELS[id],
      categoryId: null,
      parentCategoryId: null,
      accountId: null,
      color: null,
      knownMinor,
      complete: agg.isComplete,
    });
    if (side === "income") {
      addToSide("income", knownMinor, agg.isComplete);
      pushLink({
        source: id,
        target: "hub",
        knownMinor,
        complete: agg.isComplete,
      });
    } else {
      addToSide("expenses", knownMinor, agg.isComplete);
      pushLink({
        source: "hub",
        target: id,
        knownMinor,
        complete: agg.isComplete,
      });
    }
  }

  // ---- Transfer classes: inflows on the source side, outflows on the other.
  for (const [flowClass, bucket] of inflowClasses) {
    const id = INFLOW_ID[flowClass];
    const knownMinor = toMinor(bucket.agg.knownSubtotal);
    const complete = bucket.agg.isComplete;
    pushNode({
      id,
      kind: "inflow",
      label: SANKEY_FIXED_LABELS[id],
      categoryId: null,
      parentCategoryId: null,
      accountId: null,
      color: null,
      knownMinor,
      complete,
    });
    addToSide("inflows", knownMinor, complete);
    pushLink({ source: id, target: "hub", knownMinor, complete });
  }

  for (const [flowClass, bucket] of outflowClasses) {
    const id = `class:${flowClass}`;
    const knownMinor = toMinor(bucket.agg.knownSubtotal);
    const complete = bucket.agg.isComplete;
    pushNode({
      id,
      kind: "class",
      label: SANKEY_FIXED_LABELS[id],
      categoryId: null,
      parentCategoryId: null,
      accountId: null,
      color: null,
      knownMinor,
      complete,
    });
    addToSide("outflows", knownMinor, complete);
    pushLink({ source: "hub", target: id, knownMinor, complete });

    if (depth !== 2) continue;
    for (const [accountKey, entry] of classAccounts.get(flowClass) ?? []) {
      const accountNodeId = `account:${accountKey}`;
      const accountMinor = toMinor(entry.bucket.agg.knownSubtotal);
      const accountComplete = entry.bucket.agg.isComplete;
      const unlinked = accountKey === "unlinked";
      pushNode({
        id: accountNodeId,
        kind: "account",
        label: unlinked
          ? SANKEY_FIXED_LABELS["account:unlinked"]
          : (entry.name ?? SANKEY_FIXED_LABELS["account:unlinked"]),
        categoryId: null,
        parentCategoryId: null,
        accountId: unlinked ? null : accountKey,
        color: null,
        knownMinor: accountMinor,
        complete: accountComplete,
      });
      pushLink({
        source: id,
        target: accountNodeId,
        knownMinor: accountMinor,
        complete: accountComplete,
      });
    }
  }

  // ---- The residual closes the diagram (decision 7, truth table A).
  const allComplete =
    sideTotals.income.complete &&
    sideTotals.inflows.complete &&
    sideTotals.expenses.complete &&
    sideTotals.outflows.complete;
  const netMinor =
    sideTotals.income.minor +
    sideTotals.inflows.minor -
    sideTotals.expenses.minor -
    sideTotals.outflows.minor;
  const unspentMinor = allComplete ? Math.max(netMinor, 0) : null;
  const deficitMinor = allComplete ? Math.max(-netMinor, 0) : null;

  const residualId = netMinor >= 0 ? "residual:unspent" : "residual:deficit";
  const residualMinor = netMinor >= 0 ? unspentMinor : deficitMinor;
  if (!allComplete || (residualMinor !== null && residualMinor > 0)) {
    pushNode({
      id: residualId,
      kind: "residual",
      label: SANKEY_FIXED_LABELS[residualId],
      categoryId: null,
      parentCategoryId: null,
      accountId: null,
      color: null,
      // Unknown residual: nothing about it is known, not the known part's
      // difference, which would print a figure the data cannot support.
      knownMinor: allComplete ? (residualMinor ?? 0) : 0,
      complete: allComplete,
    });
    if (residualId === "residual:unspent") {
      pushLink({
        source: "hub",
        target: residualId,
        knownMinor: allComplete ? (residualMinor ?? 0) : 0,
        complete: allComplete,
      });
    } else {
      pushLink({
        source: residualId,
        target: "hub",
        knownMinor: allComplete ? (residualMinor ?? 0) : 0,
        complete: allComplete,
      });
    }
  }

  const hubKnownMinor =
    sideTotals.income.minor + sideTotals.inflows.minor + (deficitMinor ?? 0);
  if (nodes.length > 0) {
    pushNode({
      id: "hub",
      kind: "hub",
      label: SANKEY_FIXED_LABELS.hub,
      categoryId: null,
      parentCategoryId: null,
      accountId: null,
      color: null,
      knownMinor: hubKnownMinor,
      complete: allComplete,
    });
  }

  if (allComplete) {
    assertClosingIdentity(links, {
      income: sideTotals.income.minor,
      inflows: sideTotals.inflows.minor,
      expenses: sideTotals.expenses.minor,
      outflows: sideTotals.outflows.minor,
      unspent: unspentMinor ?? 0,
      deficit: deficitMinor ?? 0,
    });
  }

  const totalOf = (side: Side) =>
    sideTotals[side].complete ? fromMinor(sideTotals[side].minor) : null;

  return {
    startDate: input.startDate,
    endDate: input.endDate,
    currency,
    scopeAccountIds: input.scopeAccountIds,
    nodes: sortNodes(nodes).map(finishNode),
    links: links.map(finishLink),
    totals: {
      income: totalOf("income"),
      inflows: totalOf("inflows"),
      expenses: totalOf("expenses"),
      outflows: totalOf("outflows"),
      unspent: unspentMinor === null ? null : fromMinor(unspentMinor),
      deficit: deficitMinor === null ? null : fromMinor(deficitMinor),
    },
    knownTotals: {
      income: fromMinor(sideTotals.income.minor),
      inflows: fromMinor(sideTotals.inflows.minor),
      expenses: fromMinor(sideTotals.expenses.minor),
      outflows: fromMinor(sideTotals.outflows.minor),
    },
    missingCurrencies: [...missingCurrencies].sort(),
    excludedCount,
  };
}

/**
 * SANKEY-001 in scaled integers, read off the links actually returned rather
 * than off the totals they were built from: what enters the hub equals what
 * leaves it, both equal the totals' two sides, and every depth-2 parent's
 * child links sum (signed) to its own link.
 */
export function assertClosingIdentity(
  links: ReadonlyArray<DraftLink>,
  totals: {
    income: number;
    inflows: number;
    expenses: number;
    outflows: number;
    unspent: number;
    deficit: number;
  },
): void {
  let intoHub = 0;
  let outOfHub = 0;
  for (const link of links) {
    if (link.target === "hub") intoHub += link.knownMinor;
    if (link.source === "hub") outOfHub += link.knownMinor;
  }
  const left = totals.income + totals.inflows + totals.deficit;
  const right = totals.expenses + totals.outflows + totals.unspent;
  if (left !== right || intoHub !== left || outOfHub !== right) {
    throw new SankeyIdentityError(
      `Cash flow Sankey does not close: income ${totals.income} + inflows ${totals.inflows} + deficit ${totals.deficit} = ${left}, expenses ${totals.expenses} + outflows ${totals.outflows} + unspent ${totals.unspent} = ${right}, links into hub ${intoHub}, out of hub ${outOfHub} (ten-thousandths)`,
      left - right || intoHub - outOfHub,
    );
  }

  // Each non-hub node that has links on both sides passes through what it
  // receives (a depth-2 parent and its children, a class and its accounts).
  const through = new Map<string, { inMinor: number; outMinor: number }>();
  for (const link of links) {
    if (link.source !== "hub") {
      const entry = through.get(link.source) ?? { inMinor: 0, outMinor: 0 };
      entry.outMinor += link.knownMinor;
      through.set(link.source, entry);
    }
    if (link.target !== "hub") {
      const entry = through.get(link.target) ?? { inMinor: 0, outMinor: 0 };
      entry.inMinor += link.knownMinor;
      through.set(link.target, entry);
    }
  }
  const hasOut = new Set(links.map((l) => l.source));
  const hasIn = new Set(links.map((l) => l.target));
  for (const [id, { inMinor, outMinor }] of through) {
    if (!hasOut.has(id) || !hasIn.has(id)) continue;
    if (inMinor !== outMinor) {
      throw new SankeyIdentityError(
        `Cash flow Sankey node ${id} does not balance: in ${inMinor}, out ${outMinor} (ten-thousandths)`,
        inMinor - outMinor,
      );
    }
  }
}

const KIND_ORDER: Record<SankeyNodeKind, number> = {
  income: 0,
  uncategorized: 1,
  inflow: 2,
  hub: 3,
  expense: 4,
  child: 5,
  class: 6,
  account: 7,
  residual: 8,
};

/** Kind order, then largest known amount first, then id for a stable tie. */
function sortNodes(nodes: DraftNode[]): DraftNode[] {
  return [...nodes].sort(
    (a, b) =>
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      b.knownMinor - a.knownMinor ||
      a.id.localeCompare(b.id),
  );
}

function finishNode(node: DraftNode): CashFlowSankeyNode {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    categoryId: node.categoryId,
    parentCategoryId: node.parentCategoryId,
    accountId: node.accountId,
    color: node.color,
    total: node.complete ? fromMinor(node.knownMinor) : null,
    knownTotal: fromMinor(node.knownMinor),
  };
}

function finishLink(link: DraftLink): CashFlowSankeyLink {
  return {
    source: link.source,
    target: link.target,
    amount: link.complete ? fromMinor(link.knownMinor) : null,
    knownAmount: fromMinor(link.knownMinor),
  };
}
