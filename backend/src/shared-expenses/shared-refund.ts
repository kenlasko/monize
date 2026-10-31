import { BadRequestException } from "@nestjs/common";
import { ExactDecimal } from "../bonds/domain/exact-decimal";
import { tr } from "../i18n/translate";
import {
  SharedAllocation,
  assertDistinctParticipants,
} from "./shared-allocation";
import {
  currencyQuantum,
  fixedUnits,
  moneyText,
  SHARED_MONEY_SCALE,
} from "./shared-money";

export interface RefundShare {
  readonly participantId: string;
  readonly originalAmount: string;
  readonly groupAmount: string;
}

/**
 * Reverse each accepted share cumulatively, not by repricing a refund at today's
 * FX rate. The final original unit releases that person's stored base residual.
 */
export function refundShares(
  source: readonly RefundShare[],
  previous: readonly RefundShare[],
  requested: readonly SharedAllocation[],
  groupPlaces: number,
): { amount: string; shares: RefundShare[] } {
  currencyQuantum(groupPlaces);
  assertDistinctParticipants(source);
  assertDistinctParticipants(requested);
  const fail = () => {
    throw new BadRequestException(
      tr(
        "sharedExpenses.refundExceeded",
        "The refund exceeds a participant's remaining refundable share",
      ),
    );
  };
  const shares = requested.map((row) => {
    const original = source.find(
      (candidate) => candidate.participantId === row.participantId,
    );
    if (!original) return fail();
    const originalUnits = fixedUnits(original.originalAmount, 4);
    const baseUnits = fixedUnits(original.groupAmount, 4);
    const prior = previous
      .filter((candidate) => candidate.participantId === row.participantId)
      .reduce(
        (sum, candidate) => ({
          original: sum.original + fixedUnits(candidate.originalAmount, 4),
          base: sum.base + fixedUnits(candidate.groupAmount, 4),
        }),
        { original: 0n, base: 0n },
      );
    const current = fixedUnits(row.amount, 4);
    if (current + prior.original > originalUnits || prior.base > baseUnits)
      return fail();
    const cumulative =
      originalUnits === 0n
        ? 0n
        : fixedUnits(
            ExactDecimal.of(
              baseUnits * (prior.original + current),
              originalUnits * SHARED_MONEY_SCALE,
            ).toFixed(groupPlaces),
            4,
          );
    const delta = cumulative - prior.base;
    if (delta < 0n || cumulative > baseUnits) return fail();
    return {
      participantId: row.participantId,
      originalAmount: moneyText(current),
      groupAmount: moneyText(delta),
    };
  });
  return {
    shares,
    amount: moneyText(
      shares.reduce((sum, row) => sum + fixedUnits(row.groupAmount, 4), 0n),
    ),
  };
}
