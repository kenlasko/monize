import type { SharedJournalEntry } from "./shared-journal";
import { fixedUnits, moneyText } from "./shared-money";
import { sharedFingerprint } from "./shared-db";

export interface SharedPersonalEffect {
  readonly entryId: string;
  readonly date: string;
  readonly state: SharedJournalEntry["state"];
  readonly type: SharedJournalEntry["type"];
  /** Signed actual flow: negative paid out, positive received. */
  readonly cash: string;
  readonly originalCash: string;
  readonly originalCurrency: string;
  /** Signed categorized flow in the settlement account. */
  readonly personal: string;
  readonly position: string;
}

/** A peer's change matters only if it changes this participant's own inputs. */
export function personalEffect(
  entry: SharedJournalEntry,
  participantId: string,
): SharedPersonalEffect | null {
  if (entry.state === "DRAFT") return null;
  const sum = (kind: "SHARE" | "CONTRIBUTION", original: boolean) =>
    entry.allocations
      .filter((a) => a.kind === kind && a.participantId === participantId)
      .reduce(
        (value, a) =>
          value + fixedUnits((original ? a.originalAmount : a.groupAmount)!, 4),
        0n,
      );
  const active = entry.state === "POSTED";
  const repaymentSign =
    entry.fromParticipantId === participantId
      ? -1n
      : entry.toParticipantId === participantId
        ? 1n
        : 0n;
  const cashSign = entry.type === "EXPENSE" ? -1n : 1n;
  const cash = !active
    ? 0n
    : entry.type === "REPAYMENT"
      ? repaymentSign * fixedUnits(entry.groupAmount!, 4)
      : cashSign * sum("CONTRIBUTION", false);
  const originalCash = !active
    ? 0n
    : entry.type === "REPAYMENT"
      ? repaymentSign * fixedUnits(entry.originalAmount, 4)
      : cashSign * sum("CONTRIBUTION", true);
  const personal =
    !active || entry.type === "REPAYMENT" ? 0n : cashSign * sum("SHARE", false);
  return {
    entryId: entry.id,
    date: entry.date,
    state: entry.state,
    type: entry.type,
    cash: moneyText(cash),
    originalCash: moneyText(originalCash),
    originalCurrency: entry.currencyCode,
    personal: moneyText(personal),
    position: moneyText(personal - cash),
  };
}

export function personalFingerprint(effect: SharedPersonalEffect): string {
  return sharedFingerprint(effect);
}

export interface SharedBankBreakdown {
  readonly bankTotal: string;
  readonly sharedPortion: string;
  readonly agreedPortion: string;
  readonly privateRemainder: string;
  readonly fxDifference: string;
}

/** Three signed components retain the bank's exact amount, including its 4dp remainder. */
export function sharedBankBreakdown(
  total: string,
  shared: string,
  agreed: string,
): SharedBankBreakdown {
  const totalUnits = fixedUnits(total, 4, true);
  const sharedUnits = fixedUnits(shared, 4, true);
  const agreedUnits = fixedUnits(agreed, 4, true);
  const sign = (value: bigint) => (value < 0n ? -1n : value > 0n ? 1n : 0n);
  const abs = (value: bigint) => (value < 0n ? -value : value);
  if (
    sharedUnits === 0n ||
    sign(totalUnits) !== sign(sharedUnits) ||
    (agreedUnits !== 0n && sign(sharedUnits) !== sign(agreedUnits)) ||
    abs(sharedUnits) > abs(totalUnits)
  ) {
    throw new Error(
      "The shared portion must fit the bank movement and direction",
    );
  }
  return {
    bankTotal: moneyText(totalUnits),
    sharedPortion: moneyText(sharedUnits),
    agreedPortion: moneyText(agreedUnits),
    privateRemainder: moneyText(totalUnits - sharedUnits),
    fxDifference: moneyText(sharedUnits - agreedUnits),
  };
}
