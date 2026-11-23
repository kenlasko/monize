import type { SharedEntryInput, SharedSplitMode } from "@/types/shared-expense";
import { FIAT_MONEY_DECIMALS, toMoneyUnits } from "./format";
import { splitDraftStatus, splitRemainderEqually } from "./shared-split-draft";

type Split = Pick<SharedEntryInput, "shares" | "splitMode">;
export interface SharedSplitDraft {
  mode: SharedSplitMode;
  selected: string[];
  /** Only explicit edits are pinned; a blank receives the equal remainder. */
  values: Record<string, string>;
}

export function initialSplitDraft(input: Split): SharedSplitDraft {
  return {
    mode: input.splitMode,
    selected: input.shares.map((row) => row.participantId),
    values: Object.fromEntries(
      input.shares.map((row) => [row.participantId, row.value ?? ""]),
    ),
  };
}

export function resolveSplitDraft(
  draft: SharedSplitDraft,
  amount: string,
  places: number,
) {
  const rows = draft.selected.map((participantId) => ({
    participantId,
    ...(draft.mode === "EQUAL"
      ? {}
      : { value: draft.values[participantId] ?? "" }),
  }));
  let shares = rows;
  if (
    (draft.mode === "EXACT" || draft.mode === "PERCENT") &&
    rows.some((row) => !row.value)
  ) {
    try {
      shares = splitRemainderEqually(
        draft.mode === "PERCENT" ? "100" : amount,
        rows,
        draft.mode === "PERCENT" ? 2 : places,
      );
    } catch {
      // Keep the invalid draft visible; status names the excess/missing amount.
    }
  }
  const split: Split = { splitMode: draft.mode, shares };
  return {
    ...split,
    status: splitDraftStatus(amount, draft.mode, shares, places),
  };
}

/** Ratios for editing, not rounded money allocations (those come from the server). */
export function splitRatios(split: Split) {
  const weights = split.shares.map((row) => ({
    participantId: row.participantId,
    value: split.splitMode === "EQUAL" ? "1" : (row.value ?? ""),
  }));
  // Four-decimal instructions, summed as exact integer units (`toMoneyUnits`,
  // shifted from the decimal digits, never a float multiply) rather than
  // floating amounts. An instruction that is not a number leaves every share
  // without a percentage.
  const units = weights.map((row) => {
    const value = Number(row.value);
    return Number.isFinite(value)
      ? toMoneyUnits(value, FIAT_MONEY_DECIMALS)
      : null;
  });
  const total = units.every((unit) => unit !== null)
    ? units.reduce<bigint>((sum, unit) => sum + (unit ?? BigInt(0)), BigInt(0))
    : null;
  return Object.fromEntries(
    weights.map((row, index) => {
      const unit = units[index];
      return [
        row.participantId,
        {
          weight: row.value,
          percent:
            total !== null && total > BigInt(0) && unit !== null
              ? Math.round(Number(unit * BigInt(10000)) / Number(total)) / 100
              : undefined,
        },
      ];
    }),
  );
}

export function editSplitDraft(
  draft: SharedSplitDraft,
  amount: string,
  places: number,
  mode: Exclude<SharedSplitMode, "EQUAL">,
  participantId: string,
  value: string,
): SharedSplitDraft {
  const values =
    draft.mode === mode
      ? draft.values
      : mode === "WEIGHT"
        ? Object.fromEntries(
            Object.entries(
              splitRatios(resolveSplitDraft(draft, amount, places)),
            ).map(([id, ratio]) => [id, ratio.weight]),
          )
        : {};
  return { ...draft, mode, values: { ...values, [participantId]: value } };
}
