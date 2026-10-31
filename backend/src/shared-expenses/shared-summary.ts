import { fixedUnits, moneyText } from "./shared-money";

/** Group positions remain separate claims. Opposite signs never cancel across groups. */
export function summarizeSharedPositions(
  groups: readonly {
    id: string;
    currencyCode: string;
    archivedAt: string | null;
    myPosition: { balance: string | null; knownBalance: string } | null;
  }[],
) {
  const totals = new Map<
    string,
    { receivable: bigint; payable: bigint; unresolvedGroupIds: string[] }
  >();
  for (const group of groups) {
    if (!group.myPosition) continue;
    const current = totals.get(group.currencyCode) ?? {
      receivable: 0n,
      payable: 0n,
      unresolvedGroupIds: [],
    };
    const balance = fixedUnits(
      group.myPosition.balance ?? group.myPosition.knownBalance,
      4,
      true,
    );
    totals.set(group.currencyCode, {
      receivable: current.receivable + (balance > 0n ? balance : 0n),
      payable: current.payable + (balance < 0n ? -balance : 0n),
      unresolvedGroupIds:
        group.myPosition.balance === null
          ? [...current.unresolvedGroupIds, group.id]
          : current.unresolvedGroupIds,
    });
  }
  return [...totals]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currencyCode, value]) => ({
      currencyCode,
      receivable: value.unresolvedGroupIds.length
        ? null
        : moneyText(value.receivable),
      payable: value.unresolvedGroupIds.length
        ? null
        : moneyText(value.payable),
      knownReceivable: moneyText(value.receivable),
      knownPayable: moneyText(value.payable),
      unresolvedGroupIds: value.unresolvedGroupIds,
    }));
}
