import { createHash } from "crypto";
import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";
import {
  currencyQuantum,
  fixedUnits,
  moneyText,
  sharedAmount,
  SHARED_PARTICIPANT_LIMIT,
} from "./shared-money";

export const SHARED_SPLIT_MODES = [
  "EQUAL",
  "EXACT",
  "PERCENT",
  "WEIGHT",
] as const;
export type SharedSplitMode = (typeof SHARED_SPLIT_MODES)[number];
export interface ShareInput {
  readonly participantId: string;
  readonly value?: string;
}
export interface UnitShare {
  readonly participantId: string;
  readonly units: bigint;
}
export interface SharedAllocation {
  readonly participantId: string;
  readonly amount: string;
}

function invalidSplit(): never {
  throw new BadRequestException(
    tr(
      "sharedExpenses.invalidSplit",
      "Check the participants and allocate the entire amount",
    ),
  );
}

export function assertDistinctParticipants(
  rows: readonly { participantId: string }[],
): void {
  if (
    rows.length < 1 ||
    rows.length > SHARED_PARTICIPANT_LIMIT ||
    rows.some((row) => !row.participantId) ||
    new Set(rows.map((row) => row.participantId)).size !== rows.length
  )
    invalidSplit();
}

/** Largest remainders, with persisted seed and ID order deciding equal ties (SE-001/012). */
export function apportion(
  total: bigint,
  weights: readonly UnitShare[],
  places: number,
  seed: string,
): UnitShare[] {
  assertDistinctParticipants(weights);
  const quantum = currencyQuantum(places);
  const sum = weights.reduce((value, row) => value + row.units, 0n);
  if (
    total < 0n ||
    total % quantum !== 0n ||
    sum <= 0n ||
    weights.some((row) => row.units < 0n)
  ) {
    invalidSplit();
  }
  const ordered = [...weights].sort((a, b) =>
    a.participantId.localeCompare(b.participantId, "en"),
  );
  const offset =
    createHash("sha256").update(seed).digest().readUInt32BE(0) % ordered.length;
  const minorTotal = total / quantum;
  const rows = ordered.map((row, index) => ({
    ...row,
    floor: (minorTotal * row.units) / sum,
    remainder: (minorTotal * row.units) % sum,
    rank: (index - offset + ordered.length) % ordered.length,
  }));
  const left = Number(
    minorTotal - rows.reduce((value, row) => value + row.floor, 0n),
  );
  const priorities = [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.rank - b.rank
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  const extras = new Set(
    priorities.slice(0, left).map((row) => row.participantId),
  );
  return rows.map((row) => ({
    participantId: row.participantId,
    units: (row.floor + (extras.has(row.participantId) ? 1n : 0n)) * quantum,
  }));
}

export function allocateShares(
  amount: string,
  places: number,
  mode: SharedSplitMode,
  inputs: readonly ShareInput[],
  seed: string,
): SharedAllocation[] {
  const total = sharedAmount(amount, places);
  assertDistinctParticipants(inputs);
  if (!SHARED_SPLIT_MODES.includes(mode)) invalidSplit();
  const weighted = inputs.map((row) => ({
    participantId: row.participantId,
    units:
      mode === "EQUAL"
        ? 1n
        : mode === "EXACT"
          ? sharedAmount(row.value!, places, false)
          : fixedUnits(row.value!, mode === "PERCENT" ? 2 : 4),
  }));
  const sum = weighted.reduce((value, row) => value + row.units, 0n);
  if (
    (mode === "EXACT" && sum !== total) ||
    (mode === "PERCENT" && sum !== 10_000n)
  )
    invalidSplit();
  const shares =
    mode === "EXACT" ? weighted : apportion(total, weighted, places, seed);
  return shares.map((row) => ({
    participantId: row.participantId,
    amount: moneyText(row.units),
  }));
}

export function convertAllocations(
  total: bigint,
  original: readonly SharedAllocation[],
  places: number,
  seed: string,
): SharedAllocation[] {
  return apportion(
    total,
    original.map((row) => ({
      participantId: row.participantId,
      units: fixedUnits(row.amount, 4),
    })),
    places,
    seed,
  ).map((row) => ({
    participantId: row.participantId,
    amount: moneyText(row.units),
  }));
}
