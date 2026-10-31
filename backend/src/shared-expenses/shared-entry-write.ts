import { EntityManager } from "typeorm";
import { SharedEntryPlan } from "./shared-entry-plan";

export async function writeSharedEntry(
  manager: EntityManager,
  userId: string,
  plan: SharedEntryPlan,
  updating: boolean,
  financialChange: boolean,
): Promise<void> {
  const e = plan.entry;
  const values = [
    e.id,
    e.groupId,
    userId,
    e.type,
    e.state,
    e.draftReason,
    e.title,
    e.note,
    e.categoryLabel,
    e.date,
    e.originalAmount,
    e.currencyCode,
    e.groupAmount,
    e.fxRate,
    e.fxRateDate,
    e.fxSource,
    e.splitMode,
    e.roundingSeed,
    e.sourceEntryId,
    e.fromParticipantId,
    e.toParticipantId,
  ];
  if (!updating) {
    await manager.query(
      `INSERT INTO shared_entries (id, group_id, created_by_user_id, type, state, draft_reason, title, note, category_label, entry_date,
      original_amount, original_currency_code, group_amount, fx_rate, fx_rate_date, fx_source, split_mode, rounding_seed, source_entry_id, from_participant_id, to_participant_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      values,
    );
  } else {
    await manager.query(
      `UPDATE shared_entries SET state=$5, draft_reason=$6, title=$7, note=$8, category_label=$9, entry_date=$10,
      original_amount=$11, original_currency_code=$12, group_amount=$13, fx_rate=$14, fx_rate_date=$15, fx_source=$16, split_mode=$17,
      from_participant_id=$20, to_participant_id=$21, revision=revision+1, financial_revision=financial_revision+$22
      WHERE id=$1 AND group_id=$2 AND type=$4 AND rounding_seed=$18 AND source_entry_id IS NOT DISTINCT FROM $19::uuid
      AND (created_by_user_id=$3 OR EXISTS (SELECT 1 FROM shared_groups WHERE id=$2 AND owner_user_id=$3))`,
      [...values, financialChange ? 1 : 0],
    );
    await manager.query(
      "DELETE FROM shared_allocations WHERE entry_id = $1 AND group_id = $2",
      [e.id, e.groupId],
    );
  }
  for (const row of plan.allocations) {
    await manager.query(
      `INSERT INTO shared_allocations (group_id, entry_id, participant_id, kind, original_amount, group_amount, instruction_value)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        e.groupId,
        e.id,
        row.participantId,
        row.kind,
        row.originalAmount,
        row.groupAmount,
        row.instructionValue,
      ],
    );
  }
}
