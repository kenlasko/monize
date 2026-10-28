import { previewAccrualEditor } from "./accrual-editor-plan";
import type { AccrualEditorPreviewDto } from "./dto/accrual-editor.dto";
import {
  readAccrualSystemMovements,
  type SystemMovementInput,
} from "./reporting-system-movements";
import {
  readReportingDetails,
  type ReportingDetailsInput,
} from "./reporting-details";
import { readAccrualSystemBalances } from "./reporting-system-balances";
import { previewSourceAccrualEdit } from "./accrual-source-edit";
import type { UpdateTransactionDto } from "../transactions/dto/update-transaction.dto";
import { Injectable } from "@nestjs/common";
import { DataSource, EntityManager } from "typeorm";
import { createHash } from "node:crypto";
import { withScopedDb } from "../common/db/scoped-db";
import { buildAccrualPlan, type AccrualPeriod } from "./accrual-allocation";
import { accrualBalancesAt } from "./accrual-balance";
import {
  accrualContentFingerprint,
  accrualPreviewFingerprint,
} from "./accrual-fingerprint";
import { loadAccrualSource, requireAccrualOwner } from "./accrual-source";
import { findAccrual, storedAccrualPlan, writeAccrual } from "./accrual-store";
import {
  AccrualPreviewDto,
  AccrualCommitDto,
  AccrualRemoveDto,
} from "./dto/accrual-command.dto";
import { accrualErrors } from "./accrual-errors";

function periodOf(dto: AccrualPreviewDto): AccrualPeriod {
  if (dto.preset === "CUSTOM")
    return {
      preset: "CUSTOM",
      startMonth: dto.startMonth!,
      monthCount: dto.monthCount!,
      dateRule: dto.dateRule,
    };
  if (
    (dto.preset === "LTM" || dto.preset === "NTM") &&
    dto.startMonth === undefined &&
    dto.monthCount === undefined
  )
    return { preset: dto.preset, dateRule: dto.dateRule };
  throw accrualErrors.period();
}
function removeHash(value: string): string {
  return createHash("sha256")
    .update("remove-accrual:" + value)
    .digest("hex");
}

/** API is intentionally not imported into AppModule until source lifecycle coverage is complete. */
@Injectable()
export class AccrualsService {
  constructor(private readonly dataSource: DataSource) {}

  async sources(userId: string, sourceTransactionIds: string[]) {
    requireAccrualOwner(userId);
    return withScopedDb(this.dataSource, (m) =>
      m.query(
        `SELECT s.source_transaction_id AS "sourceTransactionId", COUNT(*)::int AS "scheduleCount"
       FROM accrual_schedules s JOIN transactions t ON t.id=s.source_transaction_id AND t.user_id=s.user_id
       WHERE s.user_id=$1 AND s.source_transaction_id=ANY($2::uuid[])
       GROUP BY s.source_transaction_id ORDER BY s.source_transaction_id`,
        [userId, sourceTransactionIds],
      ),
    );
  }

  async sourceSchedules(userId: string, transactionId: string) {
    requireAccrualOwner(userId);
    return withScopedDb(this.dataSource, async (m) => {
      // includes VOID: this lookup authorizes source identity, including a schedule that can be removed.
      const source = await m.query(
        "SELECT id FROM transactions WHERE user_id=$1 AND id=$2",
        [userId, transactionId],
      );
      if (!source[0]) throw accrualErrors.missing();
      return m.query(
        `SELECT id, source_split_id AS "sourceSplitId", preset, family,
        recognition_date_rule AS "dateRule",
        TO_CHAR(start_month,'YYYY-MM') AS "startMonth", month_count AS "monthCount", revision
        FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=$2 ORDER BY source_split_id NULLS FIRST,id`,
        [userId, transactionId],
      );
    });
  }

  async reportingDetails(userId: string, input: ReportingDetailsInput) {
    return withScopedDb(this.dataSource, (m) =>
      readReportingDetails(m, userId, input),
    );
  }
  async systemMovements(
    userId: string,
    id: string,
    input: SystemMovementInput,
  ) {
    requireAccrualOwner(userId);
    return withScopedDb(this.dataSource, (m) =>
      readAccrualSystemMovements(m, userId, id, input),
    );
  }
  async systemBalances(userId: string, asOf: string, accountIds?: string[]) {
    const balances = await withScopedDb(this.dataSource, (manager) =>
      readAccrualSystemBalances(manager, userId, [asOf], accountIds),
    );
    return { basis: "accrual" as const, asOf, accounts: balances };
  }

  private async resolve(
    m: EntityManager,
    userId: string,
    dto: AccrualPreviewDto,
    mutable: boolean,
  ) {
    const source = await loadAccrualSource(
      m,
      userId,
      dto.sourceTransactionId,
      dto.sourceSplitId ?? null,
      mutable,
    );
    const family = source.family ?? dto.family;
    if (!family) throw accrualErrors.family();
    if (source.family && dto.family && source.family !== dto.family)
      throw accrualErrors.ineligible();
    const period = periodOf(dto);
    const plan = (() => {
      try {
        return buildAccrualPlan(
          source.snapshot.paymentDate,
          source.snapshot.amount,
          source.snapshot.currencyDecimals,
          period,
        );
      } catch {
        throw accrualErrors.period();
      }
    })();
    const existing = await findAccrual(
      m,
      userId,
      source.snapshot.transactionId,
      source.snapshot.splitId,
    );
    const fingerprint = accrualPreviewFingerprint(
      source.snapshot,
      family,
      period,
      plan,
      existing?.revision ?? null,
      existing?.id ?? null,
    );
    const before = existing
      ? await storedAccrualPlan(m, userId, existing)
      : null;
    return {
      source: source.snapshot,
      family,
      period,
      plan,
      existing,
      fingerprint,
      before,
    };
  }

  async editorPreview(
    userId: string,
    id: string,
    dto: AccrualEditorPreviewDto,
  ) {
    return withScopedDb(this.dataSource, (m) =>
      previewAccrualEditor(m, userId, id, dto),
    );
  }
  async applyEditorSettings(
    userId: string,
    id: string,
    dto: AccrualEditorPreviewDto,
  ) {
    requireAccrualOwner(userId);
    return withScopedDb(this.dataSource, async (m) => {
      for (const setting of dto.settings) {
        if (setting.sourceTransactionId !== id)
          throw accrualErrors.ineligible();
        if (setting.remove) {
          await m.query(
            "DELETE FROM accrual_schedules WHERE user_id=$1 AND source_transaction_id=$2 AND source_split_id IS NOT DISTINCT FROM $3::uuid",
            [userId, id, setting.sourceSplitId ?? null],
          );
        } else {
          const input = {
            sourceTransactionId: id,
            sourceSplitId: setting.sourceSplitId,
            preset: setting.preset,
            startMonth: setting.startMonth,
            monthCount: setting.monthCount,
            family:
              (
                await loadAccrualSource(
                  m,
                  userId,
                  id,
                  setting.sourceSplitId ?? null,
                  true,
                )
              ).family ?? setting.family,
          };
          const preview = await this.preview(userId, input);
          await this.save(userId, {
            ...input,
            fingerprint: preview.fingerprint,
            expectedScheduleId: preview.expectedScheduleId,
            expectedRevision: preview.expectedRevision,
          });
        }
      }
    });
  }

  async previewSourceEdit(
    userId: string,
    transactionId: string,
    patch: UpdateTransactionDto,
  ) {
    requireAccrualOwner(userId);
    return withScopedDb(this.dataSource, (m) =>
      previewSourceAccrualEdit(m, userId, transactionId, patch),
    );
  }

  async preview(userId: string, dto: AccrualPreviewDto) {
    requireAccrualOwner(userId);
    return withScopedDb(this.dataSource, async (m) => {
      const resolved = await this.resolve(m, userId, dto, true);
      return this.previewView(resolved);
    });
  }

  private previewView(
    resolved: Awaited<ReturnType<AccrualsService["resolve"]>>,
  ) {
    const { source, family, plan, existing, fingerprint, before } = resolved;
    const dates = [
      ...new Set([
        source.paymentDate,
        ...plan.allocations.map((row) => row.recognitionDate),
      ]),
    ].sort();
    const balances = accrualBalancesAt(family, source.paymentDate, plan, dates);
    return {
      source,
      family,
      plan,
      before,
      expectedScheduleId: existing?.id ?? null,
      expectedRevision: existing?.revision ?? null,
      fingerprint,
      timingBalances: dates.map((asOf, index) => ({
        asOf,
        amount: balances[index],
      })),
    };
  }

  async save(userId: string, dto: AccrualCommitDto) {
    requireAccrualOwner(userId);
    return withScopedDb(this.dataSource, async (m) => {
      const resolved = await this.resolve(m, userId, dto, true);
      if (
        (resolved.existing?.id ?? null) !== dto.expectedScheduleId ||
        (resolved.existing?.revision ?? null) !== dto.expectedRevision ||
        resolved.fingerprint !== dto.fingerprint
      )
        throw accrualErrors.conflict();
      const id = await writeAccrual(
        m,
        userId,
        resolved.source,
        resolved.family,
        resolved.period,
        resolved.plan,
        accrualContentFingerprint(
          resolved.source,
          resolved.family,
          resolved.period,
          resolved.plan,
        ),
        resolved.existing,
      );
      return {
        id,
        revision: (resolved.existing?.revision ?? 0) + 1,
        source: resolved.source,
        family: resolved.family,
        plan: resolved.plan,
      };
    });
  }

  private async ownedSchedule(
    m: EntityManager,
    userId: string,
    id: string,
    mutable: boolean,
  ) {
    const rows = await m.query(
      `SELECT source_transaction_id AS "sourceTransactionId", source_split_id AS "sourceSplitId"
       FROM accrual_schedules WHERE user_id=$1 AND id=$2`,
      [userId, id],
    );
    if (!rows[0]) throw accrualErrors.missing();
    const source = await loadAccrualSource(
      m,
      userId,
      rows[0].sourceTransactionId,
      rows[0].sourceSplitId,
      mutable,
      false,
    );
    const schedule = await findAccrual(
      m,
      userId,
      source.snapshot.transactionId,
      source.snapshot.splitId,
    );
    if (!schedule || schedule.id !== id) throw accrualErrors.missing();
    const plan = await storedAccrualPlan(m, userId, schedule);
    const period: AccrualPeriod =
      schedule.preset === "CUSTOM"
        ? {
            preset: "CUSTOM",
            startMonth: schedule.startMonth,
            monthCount: schedule.monthCount,
            dateRule: schedule.recognitionDateRule,
          }
        : { preset: schedule.preset, dateRule: schedule.recognitionDateRule };
    const fingerprint = removeHash(
      accrualPreviewFingerprint(
        source.snapshot,
        schedule.family,
        period,
        plan,
        schedule.revision,
        schedule.id,
      ),
    );
    return { source: source.snapshot, schedule, plan, fingerprint };
  }

  async detail(userId: string, id: string) {
    requireAccrualOwner(userId);
    return withScopedDb(this.dataSource, (m) =>
      this.ownedSchedule(m, userId, id, false),
    );
  }
  async remove(userId: string, id: string, dto: AccrualRemoveDto) {
    requireAccrualOwner(userId);
    return withScopedDb(this.dataSource, async (m) => {
      const value = await this.ownedSchedule(m, userId, id, true);
      if (
        value.fingerprint !== dto.fingerprint ||
        value.schedule.revision !== dto.expectedRevision
      )
        throw accrualErrors.conflict();
      await m.query(
        "DELETE FROM accrual_schedules WHERE user_id=$1 AND id=$2",
        [userId, id],
      );
      return { removed: true, sourceTransactionId: value.source.transactionId };
    });
  }
}
