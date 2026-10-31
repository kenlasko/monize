import {
  drop,
  keep,
  konst,
  mask,
  scale,
  TableRules,
} from "./support-backup-rule-kinds";
import { apportion } from "../../shared-expenses/shared-allocation";
import { fixedUnits, moneyText } from "../../shared-expenses/shared-money";

export const SHARED_RULES: Record<string, TableRules> = {
  shared_groups: {
    id: keep,
    owner_user_id: keep,
    ownership_request_id: drop,
    ownership_candidate_id: drop,
    name: mask,
    description: drop,
    currency_code: keep,
    financial_revision: keep,
    revision: keep,
    split_template: drop,
    is_detached_copy: keep,
    archived_at: keep,
    created_at: keep,
    updated_at: keep,
    _snapshot_participant_id: keep,
  },
  shared_participants: {
    id: keep,
    group_id: keep,
    name: mask,
    is_active: keep,
    created_at: keep,
  },
  shared_entries: {
    id: keep,
    group_id: keep,
    created_by_user_id: drop,
    type: keep,
    state: keep,
    draft_reason: keep,
    title: mask,
    note: drop,
    category_label: drop,
    entry_date: keep,
    original_amount: scale,
    original_currency_code: keep,
    group_amount: scale,
    fx_rate: keep,
    fx_rate_date: keep,
    fx_source: keep,
    split_mode: konst("EXACT"),
    rounding_seed: keep,
    allocation_version: keep,
    revision: keep,
    financial_revision: keep,
    source_entry_id: keep,
    from_participant_id: keep,
    to_participant_id: keep,
    reversal_reason: drop,
    created_at: keep,
    updated_at: keep,
  },
  shared_allocations: {
    id: keep,
    group_id: keep,
    entry_id: keep,
    participant_id: keep,
    kind: keep,
    original_amount: scale,
    group_amount: scale,
    instruction_value: drop,
  },
  shared_activity: {
    id: keep,
    group_id: keep,
    entry_id: keep,
    actor_user_id: drop,
    actor_name: mask,
    action: keep,
    detail: konst({}),
    created_at: keep,
  },
  shared_people: {
    id: keep,
    user_id: keep,
    name: mask,
    payee_id: keep,
    created_at: keep,
  },
  shared_person_links: {
    id: keep,
    user_id: keep,
    person_id: keep,
    group_id: keep,
    participant_id: keep,
  },
};

type Tables = Record<string, Record<string, unknown>[]>;

/** Scaled shares must still conserve both original and accepted group amounts. */
export function reconcileSharedSupport(tables: Tables): Tables {
  if (!tables.shared_entries) return tables;
  const allocations = tables.shared_allocations ?? [];
  const entries = tables.shared_entries ?? [];
  const next = new Map(allocations.map((a) => [a.id, { ...a }]));
  const repaired = entries.map((entry) => {
    const original = fixedUnits(String(entry.original_amount), 4);
    const row: Record<string, unknown> = {
      ...entry,
      original_amount: moneyText(original > 0n ? original : 1n),
    };
    if (row.type === "REPAYMENT") return row;
    for (const kind of ["SHARE", "CONTRIBUTION"] as const) {
      const rows = allocations.filter(
        (a) => a.entry_id === row.id && a.kind === kind,
      );
      if (!rows.length) continue;
      for (const column of ["original_amount", "group_amount"] as const) {
        if (row[column] === null) continue;
        const total = fixedUnits(String(row[column]), 4);
        // A tiny magnitude can scale every weight to zero: equal distribution
        // remains meaningful for synthetic data, while preserving its total.
        const allZero = rows.every(
          (a) => fixedUnits(String(a[column] ?? 0), 4) === 0n,
        );
        const result = apportion(
          total,
          rows.map((a) => ({
            participantId: String(a.participant_id),
            units: allZero ? 1n : fixedUnits(String(a[column] ?? 0), 4),
          })),
          4,
          String(row.rounding_seed),
        );
        for (const share of result) {
          const source = rows.find(
            (a) => a.participant_id === share.participantId,
          )!;
          const target = next.get(source.id)!;
          next.set(source.id, {
            ...target,
            [column]: moneyText(share.units),
            ...(column === "original_amount"
              ? { instruction_value: moneyText(share.units) }
              : {}),
          });
        }
      }
    }
    return row;
  });
  return {
    ...tables,
    shared_entries: repaired,
    shared_allocations: [...next.values()],
  };
}
