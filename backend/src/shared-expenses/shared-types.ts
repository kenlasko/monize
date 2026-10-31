import { SharedEntryType } from "./shared-balances";
import { SharedSplitMode } from "./shared-allocation";

export type SharedRole = "OWNER" | "EDITOR" | "VIEWER";
export interface SharedGroup {
  ownershipTransfer?: {
    requestId: string;
    participantId: string;
    accepted: boolean;
  } | null;
  splitTemplate?: {
    mode: "EQUAL" | "PERCENT" | "WEIGHT";
    shares: { participantId: string; value?: string }[];
  } | null;
  muted?: boolean;
  isDetachedCopy?: boolean;
  id: string;
  ownerUserId: string;
  name: string;
  description: string | null;
  currencyCode: string;
  decimalPlaces: number;
  revision: number;
  financialRevision: number;
  archivedAt: string | null;
  role: SharedRole;
  myParticipantId: string | null;
}
export interface SharedParticipant {
  id: string;
  name: string;
  isActive: boolean;
  connected: boolean;
  role: SharedRole | null;
}
export interface SharedEntry {
  id: string;
  groupId: string;
  createdByUserId: string | null;
  type: SharedEntryType;
  state: "POSTED" | "DRAFT" | "REVERSED";
  draftReason: "FUTURE_DATE" | "MISSING_RATE" | null;
  title: string;
  note: string | null;
  categoryLabel: string | null;
  date: string;
  originalAmount: string;
  currencyCode: string;
  groupAmount: string | null;
  fxRate: string | null;
  fxRateDate: string | null;
  fxSource: string | null;
  splitMode: SharedSplitMode;
  roundingSeed: string;
  revision: number;
  financialRevision: number;
  sourceEntryId: string | null;
  fromParticipantId: string | null;
  toParticipantId: string | null;
}
export interface StoredAllocation {
  entryId: string;
  participantId: string;
  kind: "SHARE" | "CONTRIBUTION";
  originalAmount: string;
  groupAmount: string | null;
  instructionValue: string | null;
}
export const SHARED_ENTRY_SELECT = `
  id, group_id AS "groupId", created_by_user_id AS "createdByUserId",
  type, state, draft_reason AS "draftReason", title, note,
  category_label AS "categoryLabel", TO_CHAR(entry_date, 'YYYY-MM-DD') AS date,
  original_amount AS "originalAmount", original_currency_code AS "currencyCode",
  group_amount AS "groupAmount", fx_rate AS "fxRate",
  TO_CHAR(fx_rate_date, 'YYYY-MM-DD') AS "fxRateDate", fx_source AS "fxSource",
  split_mode AS "splitMode", rounding_seed AS "roundingSeed", revision,
  financial_revision AS "financialRevision", source_entry_id AS "sourceEntryId",
  from_participant_id AS "fromParticipantId", to_participant_id AS "toParticipantId"`;

export const SHARED_ALLOCATION_SELECT = `
  entry_id AS "entryId", participant_id AS "participantId", kind,
  original_amount AS "originalAmount", group_amount AS "groupAmount",
  instruction_value AS "instructionValue"`;
