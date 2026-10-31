import { personalEffect } from "./shared-projection";
import { fixedUnits } from "./shared-money";
import { Injectable } from "@nestjs/common";
import { DataSource } from "typeorm";
import { withScopedDb } from "../common/db/scoped-db";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import { SharedEntryDto, ReverseSharedEntryDto } from "./dto/shared-entry.dto";
import {
  advanceSharedRevision,
  lockSharedGroup,
  requireRevision,
  requireSharedGroup,
  sharedActivity,
  sharedCommand,
  sharedFingerprint,
} from "./shared-db";
import { sharedError } from "./shared-errors";
import { publicSharedEntry, readSharedJournal } from "./shared-journal";
import { planSharedEntry, sharedFinancialShape } from "./shared-entry-plan";
import { writeSharedEntry } from "./shared-entry-write";
import { todayYMD } from "../common/date-utils";
import { currencyPlaces } from "./shared-db";

@Injectable()
export class SharedEntriesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rates: ExchangeRateService,
  ) {}

  async get(userId: string, groupId: string, entryId: string) {
    return withScopedDb(
      this.dataSource,
      async (manager) => {
        const group = await requireSharedGroup(manager, userId, groupId);
        const entry = (await readSharedJournal(manager, groupId)).find(
          (e) => e.id === entryId,
        );
        if (!entry) sharedError("notFound");
        return publicSharedEntry(
          entry,
          userId,
          group.role === "OWNER",
          group.myParticipantId,
        );
      },
      "REPEATABLE READ",
    );
  }

  async preview(
    userId: string,
    groupId: string,
    dto: SharedEntryDto,
    entryId?: string,
    ratesPrepared = false,
  ) {
    return this.resolve(userId, groupId, dto, entryId, true, ratesPrepared);
  }

  async save(
    userId: string,
    groupId: string,
    dto: SharedEntryDto,
    entryId?: string,
    ratesPrepared = false,
  ) {
    return this.resolve(userId, groupId, dto, entryId, false, ratesPrepared);
  }

  async prepareRates(
    userId: string,
    groupId: string,
    dto: SharedEntryDto,
    entryId?: string,
  ) {
    // One bounded provider window, outside the locked journal transaction.
    // Accepted rates and linked refunds do not ask a provider to reprice them.
    if (!dto.fxRate && !dto.sourceEntryId && dto.date <= todayYMD()) {
      const target = await withScopedDb(this.dataSource, async (manager) => {
        const group = await requireSharedGroup(
          manager,
          userId,
          groupId,
          "WRITE",
        );
        await currencyPlaces(manager, dto.currencyCode);
        const prior = entryId
          ? (await readSharedJournal(manager, groupId)).find(
              (entry) => entry.id === entryId,
            )
          : null;
        return prior?.fxRate &&
          prior.currencyCode === dto.currencyCode &&
          prior.date === dto.date &&
          fixedUnits(prior.originalAmount, 4) === fixedUnits(dto.amount, 4)
          ? null
          : group.currencyCode;
      });
      if (target && target !== dto.currencyCode)
        await this.rates.getRateForDate(dto.currencyCode, target, dto.date);
    }
  }

  private async resolve(
    userId: string,
    groupId: string,
    dto: SharedEntryDto,
    entryId: string | undefined,
    preview: boolean,
    ratesPrepared = false,
  ) {
    if (!ratesPrepared) await this.prepareRates(userId, groupId, dto, entryId);
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId, "WRITE");
      const execute = async () => {
        const journal = await readSharedJournal(manager, groupId);
        const previous = entryId
          ? journal.find((e) => e.id === entryId)
          : undefined;
        if (entryId && !previous) sharedError("notFound");
        if (
          previous &&
          (previous.state === "REVERSED" ||
            (group.role !== "OWNER" && previous.createdByUserId !== userId))
        )
          sharedError("readOnly");
        requireRevision(previous?.revision ?? 0, dto.expectedRevision);
        const plan = await planSharedEntry(
          manager,
          this.rates,
          group,
          dto,
          entryId ?? dto.operationId,
          previous,
        );
        const financialChanged =
          !previous ||
          sharedFingerprint(
            sharedFinancialShape({
              entry: previous,
              allocations: previous.allocations,
            }),
          ) !== sharedFingerprint(sharedFinancialShape(plan));
        if (
          financialChanged &&
          previous &&
          journal.some(
            (e) => e.sourceEntryId === previous.id && e.state !== "REVERSED",
          )
        )
          sharedError("refunded");
        const previewFingerprint = sharedFingerprint(
          sharedFinancialShape(plan),
        );
        if (
          !preview &&
          dto.previewFingerprint &&
          dto.previewFingerprint !== previewFingerprint
        )
          sharedError("stale");
        if (!preview) {
          await writeSharedEntry(
            manager,
            userId,
            plan,
            !!previous,
            financialChanged,
          );
          await advanceSharedRevision(manager, groupId, financialChanged);
          await sharedActivity(
            manager,
            userId,
            groupId,
            previous ? "ENTRY_UPDATED" : "ENTRY_CREATED",
            {
              title: plan.entry.title,
              financialChanged,
              affectedParticipantIds: [
                ...new Set(
                  [...plan.allocations, ...(previous?.allocations ?? [])]
                    .map((a) => a.participantId)
                    .concat(
                      [
                        plan.entry.fromParticipantId,
                        plan.entry.toParticipantId,
                        previous?.fromParticipantId,
                        previous?.toParticipantId,
                      ].filter((id): id is string => !!id),
                    ),
                ),
              ],
              type: plan.entry.type,
              revision: (previous?.revision ?? 0) + 1,
              previous: previous
                ? {
                    ...sharedFinancialShape({
                      entry: previous,
                      allocations: previous.allocations,
                    }),
                    title: previous.title,
                    note: previous.note,
                    categoryLabel: previous.categoryLabel,
                  }
                : null,
            },
            plan.entry.id,
          );
        }
        return {
          ...plan.entry,
          allocations: plan.allocations,
          canEdit: true,
          revision: (previous?.revision ?? 0) + 1,
          financialRevision:
            (previous?.financialRevision ?? 0) + (financialChanged ? 1 : 0),
          preview,
          previewFingerprint,
          ownEffect: group.myParticipantId
            ? personalEffect(
                {
                  ...plan.entry,
                  allocations: plan.allocations,
                  createdByUserId: userId,
                  revision: (previous?.revision ?? 0) + 1,
                  financialRevision:
                    (previous?.financialRevision ?? 0) +
                    (financialChanged ? 1 : 0),
                },
                group.myParticipantId,
              )
            : null,
        };
      };
      return preview
        ? execute()
        : sharedCommand(
            manager,
            userId,
            groupId,
            dto.operationId,
            { ...dto, entryId },
            execute,
          );
    });
  }

  async reverse(
    userId: string,
    groupId: string,
    entryId: string,
    dto: ReverseSharedEntryDto,
  ) {
    return withScopedDb(this.dataSource, async (manager) => {
      await lockSharedGroup(manager, groupId);
      const group = await requireSharedGroup(manager, userId, groupId, "WRITE");
      return sharedCommand(
        manager,
        userId,
        groupId,
        dto.operationId,
        { ...dto, entryId, action: "REVERSE" },
        async () => {
          const journal = await readSharedJournal(manager, groupId);
          const entry = journal.find((e) => e.id === entryId);
          if (!entry) sharedError("notFound");
          if (
            entry.state === "REVERSED" ||
            (group.role !== "OWNER" && entry.createdByUserId !== userId)
          )
            sharedError("readOnly");
          requireRevision(entry.revision, dto.expectedRevision);
          if (!dto.reason.trim()) sharedError("participant");
          if (
            journal.some(
              (e) => e.sourceEntryId === entry.id && e.state !== "REVERSED",
            )
          )
            sharedError("refunded");
          await manager.query(
            "UPDATE shared_entries SET state = 'REVERSED', draft_reason = NULL, reversal_reason = $3, revision = revision + 1, financial_revision = financial_revision + 1 WHERE id = $1 AND group_id = $2",
            [entryId, groupId, dto.reason.trim()],
          );
          await advanceSharedRevision(manager, groupId, true);
          await sharedActivity(
            manager,
            userId,
            groupId,
            "ENTRY_REVERSED",
            {
              title: entry.title,
              reason: dto.reason.trim(),
              affectedParticipantIds: [
                ...new Set(
                  entry.allocations
                    .map((a) => a.participantId)
                    .concat(
                      [entry.fromParticipantId, entry.toParticipantId].filter(
                        (id): id is string => !!id,
                      ),
                    ),
                ),
              ],
            },
            entryId,
          );
          return { id: entryId, revision: entry.revision + 1 };
        },
      );
    });
  }
}
