import { SharedAllocation } from "./shared-allocation";
import { fixedUnits, moneyText } from "./shared-money";

export const SHARED_ENTRY_TYPES = [
  "EXPENSE",
  "REFUND",
  "INCOME",
  "REPAYMENT",
] as const;
export type SharedEntryType = (typeof SHARED_ENTRY_TYPES)[number];

export interface BalanceEntry {
  readonly type: SharedEntryType;
  readonly amount: string | null;
  readonly shares: readonly SharedAllocation[];
  readonly contributions: readonly SharedAllocation[];
  readonly fromParticipantId?: string | null;
  readonly toParticipantId?: string | null;
}

export interface SharedPosition {
  readonly participantId: string;
  readonly paid: string | null;
  readonly cost: string | null;
  readonly income: string | null;
  readonly incomeReceived: string | null;
  readonly sent: string | null;
  readonly received: string | null;
  readonly balance: string | null;
  readonly knownBalance: string;
}

export interface SharedSuggestion {
  readonly fromParticipantId: string;
  readonly toParticipantId: string;
  readonly amount: string;
}

/** The journal read decides which revisions are active; this reducer never reads bank rows. */
export function sharedBalances(
  participantIds: readonly string[],
  entries: readonly BalanceEntry[],
) {
  const complete = entries.every((entry) => entry.amount !== null);
  const sum = (rows: readonly SharedAllocation[], id: string) =>
    rows
      .filter((row) => row.participantId === id)
      .reduce((value, row) => value + fixedUnits(row.amount, 4), 0n);
  const known = entries.filter((entry) => entry.amount !== null);
  const positions: SharedPosition[] = participantIds.map((participantId) => {
    const values = known.reduce(
      (value, entry) => {
        const contribution = sum(entry.contributions, participantId);
        const share = sum(entry.shares, participantId);
        const amount = fixedUnits(entry.amount!, 4);
        return {
          paid:
            value.paid +
            (entry.type === "EXPENSE"
              ? contribution
              : entry.type === "REFUND"
                ? -contribution
                : 0n),
          cost:
            value.cost +
            (entry.type === "EXPENSE"
              ? share
              : entry.type === "REFUND"
                ? -share
                : 0n),
          income: value.income + (entry.type === "INCOME" ? share : 0n),
          incomeReceived:
            value.incomeReceived +
            (entry.type === "INCOME" ? contribution : 0n),
          sent:
            value.sent +
            (entry.type === "REPAYMENT" &&
            entry.fromParticipantId === participantId
              ? amount
              : 0n),
          received:
            value.received +
            (entry.type === "REPAYMENT" &&
            entry.toParticipantId === participantId
              ? amount
              : 0n),
        };
      },
      {
        paid: 0n,
        cost: 0n,
        income: 0n,
        incomeReceived: 0n,
        sent: 0n,
        received: 0n,
      },
    );
    const balance = moneyText(
      values.paid -
        values.cost +
        values.income -
        values.incomeReceived +
        values.sent -
        values.received,
    );
    return {
      participantId,
      paid: complete ? moneyText(values.paid) : null,
      cost: complete ? moneyText(values.cost) : null,
      income: complete ? moneyText(values.income) : null,
      incomeReceived: complete ? moneyText(values.incomeReceived) : null,
      sent: complete ? moneyText(values.sent) : null,
      received: complete ? moneyText(values.received) : null,
      balance: complete ? balance : null,
      knownBalance: balance,
    };
  });
  const netExpenses = known.reduce(
    (value, entry) =>
      value +
      (entry.type === "EXPENSE"
        ? fixedUnits(entry.amount!, 4)
        : entry.type === "REFUND"
          ? -fixedUnits(entry.amount!, 4)
          : 0n),
    0n,
  );
  const income = known
    .filter((entry) => entry.type === "INCOME")
    .reduce((value, entry) => value + fixedUnits(entry.amount!, 4), 0n);
  return {
    positions,
    settlementReady: complete,
    totalExpenses: complete ? moneyText(netExpenses) : null,
    knownExpenses: moneyText(netExpenses),
    totalIncome: complete ? moneyText(income) : null,
    knownIncome: moneyText(income),
    suggestions: complete ? suggestRepayments(positions) : [],
  };
}

/** Stable netting, bounded by the number of nonzero positions; no global-minimum claim. */
export function suggestRepayments(
  positions: readonly SharedPosition[],
): SharedSuggestion[] {
  if (positions.some((position) => position.balance === null)) return [];
  const order = (
    a: { id: string; units: bigint },
    b: { id: string; units: bigint },
  ) =>
    a.units === b.units
      ? a.id.localeCompare(b.id, "en")
      : a.units > b.units
        ? -1
        : 1;
  const sides = positions.map((position) => ({
    id: position.participantId,
    units: fixedUnits(position.balance!, 4, true),
  }));
  if (sides.reduce((value, row) => value + row.units, 0n) !== 0n) {
    throw new Error("Shared journal positions do not sum to zero");
  }
  const creditors = sides.filter((row) => row.units > 0n).sort(order);
  const debtors = sides
    .filter((row) => row.units < 0n)
    .map((row) => ({ ...row, units: -row.units }))
    .sort(order);
  const result: SharedSuggestion[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  let owed = debtors[0]?.units ?? 0n;
  let claim = creditors[0]?.units ?? 0n;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const amount = owed < claim ? owed : claim;
    result.push({
      fromParticipantId: debtors[debtorIndex].id,
      toParticipantId: creditors[creditorIndex].id,
      amount: moneyText(amount),
    });
    owed -= amount;
    claim -= amount;
    if (owed === 0n) owed = debtors[++debtorIndex]?.units ?? 0n;
    if (claim === 0n) claim = creditors[++creditorIndex]?.units ?? 0n;
  }
  return result;
}
