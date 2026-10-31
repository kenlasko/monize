import { EntityManager } from "typeorm";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { todayYMD } from "../common/date-utils";
import { roundFxRate } from "../common/fx-entry.util";
import { SharedEntryDto } from "./dto/shared-entry.dto";
import {
  allocateShares,
  convertAllocations,
  SharedAllocation,
} from "./shared-allocation";
import {
  convertSharedAmount,
  fixedUnits,
  moneyText,
  sharedAmount,
} from "./shared-money";
import { currencyPlaces, sharedParticipants } from "./shared-db";
import { sharedError } from "./shared-errors";
import { SharedEntry, SharedGroup, StoredAllocation } from "./shared-types";
import {
  journalBalances,
  readSharedJournal,
  SharedJournalEntry,
} from "./shared-journal";
import { refundShares } from "./shared-refund";
import { unchangedAllocationInstructions } from "./shared-unchanged-allocation";

export interface SharedEntryPlan {
  entry: Omit<
    SharedEntry,
    "createdByUserId" | "revision" | "financialRevision"
  >;
  allocations: StoredAllocation[];
}

/** The same resolver is used by preview and commit; accepted FX stays frozen. */
export async function planSharedEntry(
  manager: EntityManager,
  rates: ExchangeRateService,
  group: SharedGroup,
  dto: SharedEntryDto,
  entryId: string,
  previous?: SharedJournalEntry,
): Promise<SharedEntryPlan> {
  const participants = await sharedParticipants(manager, group.id);
  const allowed = new Set(
    participants
      .filter(
        (p) =>
          p.isActive ||
          previous?.allocations.some((a) => a.participantId === p.id) ||
          previous?.fromParticipantId === p.id ||
          previous?.toParticipantId === p.id,
      )
      .map((p) => p.id),
  );
  const used = [...dto.shares, ...dto.contributions].map(
    (p) => p.participantId,
  );
  if (dto.fromParticipantId) used.push(dto.fromParticipantId);
  if (dto.toParticipantId) used.push(dto.toParticipantId);
  if (used.some((id) => !allowed.has(id))) sharedError("participant");
  if (!dto.title.trim()) sharedError("participant");
  const places = await currencyPlaces(manager, dto.currencyCode);
  const originalUnits = sharedAmount(dto.amount, places);
  const originalAmount = moneyText(originalUnits);
  const seed = previous?.roundingSeed ?? `seed:${dto.operationId}`;
  if (
    previous &&
    (dto.type !== previous.type ||
      (dto.sourceEntryId ?? null) !== previous.sourceEntryId)
  )
    sharedError("readOnly");
  if ((dto.type === "REFUND") !== !!dto.sourceEntryId)
    sharedError("refundSource");
  if (
    dto.type !== "REPAYMENT" &&
    (dto.fromParticipantId || dto.toParticipantId)
  )
    sharedError("repayment");
  const future = dto.date > todayYMD();
  const preserveRate =
    previous &&
    previous.originalAmount === originalAmount &&
    previous.currencyCode === dto.currencyCode &&
    previous.date === dto.date;
  const resolved = await rates.resolveStoredRate(
    dto.currencyCode,
    group.currencyCode,
    dto.date,
  );
  const rate =
    dto.currencyCode === group.currencyCode
      ? "1.0000000000"
      : ((dto.fxRate === undefined
          ? undefined
          : roundFxRate(Number(dto.fxRate)).toFixed(10)) ??
        (preserveRate ? previous.fxRate : null) ??
        (resolved.rate === null
          ? null
          : roundFxRate(resolved.rate).toFixed(10)));
  const converted =
    rate === null
      ? null
      : convertSharedAmount(originalUnits, rate, group.decimalPlaces);
  const groupAmount = converted === null ? null : moneyText(converted);
  const state = future || rate === null ? "DRAFT" : "POSTED";
  const base: SharedEntryPlan["entry"] = {
    id: entryId,
    groupId: group.id,
    type: dto.type,
    state,
    draftReason: future ? "FUTURE_DATE" : rate === null ? "MISSING_RATE" : null,
    title: dto.title.trim(),
    note: dto.note ?? null,
    categoryLabel: dto.categoryLabel ?? null,
    date: dto.date,
    originalAmount,
    currencyCode: dto.currencyCode,
    groupAmount,
    fxRate: rate,
    fxRateDate: dto.fxRate
      ? dto.date
      : preserveRate
        ? previous.fxRateDate
        : resolved.observedOn,
    fxSource:
      dto.currencyCode === group.currencyCode
        ? "IDENTITY"
        : dto.fxRate
          ? "MANUAL"
          : preserveRate
            ? previous.fxSource
            : resolved.rate === null
              ? null
              : "MARKET",
    splitMode: dto.splitMode,
    roundingSeed: seed,
    sourceEntryId: dto.sourceEntryId ?? null,
    fromParticipantId: dto.fromParticipantId ?? null,
    toParticipantId: dto.toParticipantId ?? null,
  };
  if (
    previous &&
    preserveRate &&
    state === previous.state &&
    rate === previous.fxRate &&
    (dto.fromParticipantId ?? null) === previous.fromParticipantId &&
    (dto.toParticipantId ?? null) === previous.toParticipantId &&
    unchangedAllocationInstructions(dto, previous)
  ) {
    return {
      entry: { ...base, groupAmount: previous.groupAmount },
      allocations: previous.allocations.map((allocation) => ({
        ...allocation,
      })),
    };
  }
  if (dto.type === "REPAYMENT") {
    if (
      !dto.fromParticipantId ||
      !dto.toParticipantId ||
      dto.fromParticipantId === dto.toParticipantId ||
      dto.shares.length ||
      dto.contributions.length
    )
      sharedError("repayment");
    if (!future && rate !== null) {
      const journal = await readSharedJournal(manager, group.id);
      const balances = journalBalances(
        participants.map((p) => p.id),
        journal.filter((e) => e.id !== entryId),
      );
      if (!balances.settlementReady) sharedError("unknownBalance");
      if (dto.expectedGroupRevision !== group.financialRevision)
        sharedError("repaymentChanged");
      const payer = fixedUnits(
        balances.positions.find(
          (p) => p.participantId === dto.fromParticipantId,
        )!.balance!,
        4,
        true,
      );
      const receiver = fixedUnits(
        balances.positions.find((p) => p.participantId === dto.toParticipantId)!
          .balance!,
        4,
        true,
      );
      if (
        !dto.acknowledgeOverpayment &&
        (converted! > -payer || converted! > receiver)
      )
        sharedError("repaymentChanged");
    }
    return { entry: base, allocations: [] };
  }
  const originalShares = allocateShares(
    originalAmount,
    places,
    dto.splitMode,
    dto.shares,
    seed,
  );
  const originalContributions = allocateShares(
    originalAmount,
    places,
    "EXACT",
    dto.contributions,
    `${seed}:paid`,
  );
  let convertedShares =
    converted === null
      ? null
      : convertAllocations(
          converted,
          originalShares,
          group.decimalPlaces,
          seed,
        );
  let convertedContributions =
    converted === null
      ? null
      : convertAllocations(
          converted,
          originalContributions,
          group.decimalPlaces,
          `${seed}:paid`,
        );
  let entry = base;
  if (dto.type === "REFUND") {
    const journal = await readSharedJournal(manager, group.id);
    const source = journal.find(
      (e) =>
        e.id === dto.sourceEntryId &&
        e.type === "EXPENSE" &&
        e.state === "POSTED" &&
        e.currencyCode === dto.currencyCode,
    );
    if (!source || dto.date < source.date) sharedError("refundSource");
    const priorRefunds = journal.filter(
      (e) =>
        e.sourceEntryId === source.id &&
        e.id !== entryId &&
        e.state !== "REVERSED",
    );
    const refund = refundShares(
      source.allocations
        .filter((a) => a.kind === "SHARE")
        .map((a) => ({ ...a, groupAmount: a.groupAmount! })),
      priorRefunds.flatMap((e) =>
        e.allocations
          .filter((a) => a.kind === "SHARE")
          .map((a) => ({ ...a, groupAmount: a.groupAmount! })),
      ),
      originalShares,
      group.decimalPlaces,
    );
    convertedShares = refund.shares.map((a) => ({
      participantId: a.participantId,
      amount: a.groupAmount,
    }));
    convertedContributions = convertAllocations(
      fixedUnits(refund.amount, 4),
      originalContributions,
      group.decimalPlaces,
      `${seed}:paid`,
    );
    entry = {
      ...base,
      state: future ? "DRAFT" : "POSTED",
      draftReason: future ? "FUTURE_DATE" : null,
      groupAmount: refund.amount,
      fxRate: source.fxRate,
      fxRateDate: source.fxRateDate,
      fxSource: "ORIGINAL_REFUND",
    };
  }
  const rows = (
    original: SharedAllocation[],
    convertedRows: SharedAllocation[] | null,
    kind: StoredAllocation["kind"],
  ): StoredAllocation[] =>
    original.map((row) => ({
      entryId,
      participantId: row.participantId,
      kind,
      originalAmount: row.amount,
      groupAmount:
        convertedRows?.find((a) => a.participantId === row.participantId)
          ?.amount ?? null,
      instructionValue:
        (kind === "SHARE" ? dto.shares : dto.contributions).find(
          (a) => a.participantId === row.participantId,
        )?.value ?? null,
    }));
  return {
    entry,
    allocations: [
      ...rows(originalShares, convertedShares, "SHARE"),
      ...rows(originalContributions, convertedContributions, "CONTRIBUTION"),
    ],
  };
}

/** Only changes affecting a participant's finances advance the financial revision. */
export function sharedFinancialShape(plan: {
  entry: Pick<
    SharedEntry,
    | "type"
    | "state"
    | "date"
    | "originalAmount"
    | "currencyCode"
    | "groupAmount"
    | "fxRate"
    | "fromParticipantId"
    | "toParticipantId"
  >;
  allocations: StoredAllocation[];
}) {
  const {
    type,
    state,
    date,
    originalAmount,
    currencyCode,
    groupAmount,
    fxRate,
    fromParticipantId,
    toParticipantId,
  } = plan.entry;
  return {
    type,
    state,
    date,
    originalAmount,
    currencyCode,
    groupAmount,
    fxRate,
    fromParticipantId,
    toParticipantId,
    allocations: plan.allocations
      .map(
        ({
          participantId,
          kind,
          originalAmount: amount,
          groupAmount: converted,
        }) => ({ participantId, kind, amount, converted }),
      )
      .sort((a, b) =>
        `${a.participantId}:${a.kind}`.localeCompare(
          `${b.participantId}:${b.kind}`,
        ),
      ),
  };
}
