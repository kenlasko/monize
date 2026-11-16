import { ApiProperty } from "@nestjs/swagger";

export const DUPLICATE_CONFIDENCE_LEVELS = [
  "very_high",
  "high",
  "medium",
  "low",
] as const;

export type DuplicateConfidence = (typeof DUPLICATE_CONFIDENCE_LEVELS)[number];

/**
 * What a group's members have in common, for the client to translate. `reason`
 * stays beside it as the English rendering for existing API consumers.
 */
export const DUPLICATE_REASON_CODES = [
  "same_date_amount_payee_category",
  "same_date_amount_payee",
  "same_date_amount",
  "same_payee_amount_within_days",
  "same_amount_within_days",
] as const;

export type DuplicateReasonCode = (typeof DUPLICATE_REASON_CODES)[number];

export class DuplicateTransactionItem {
  @ApiProperty()
  id: string;

  @ApiProperty()
  transactionDate: string;

  @ApiProperty()
  amount: number;

  @ApiProperty({
    description: "The account's currency, which the amount is in",
  })
  currencyCode: string;

  @ApiProperty()
  accountId: string;

  @ApiProperty({ nullable: true })
  payeeName: string | null;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  accountName: string | null;

  @ApiProperty({ nullable: true })
  categoryId: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Full category path ("Parent: Child"); null when none',
  })
  categoryName: string | null;

  @ApiProperty()
  isSplit: boolean;

  @ApiProperty({ nullable: true })
  status: string | null;
}

export class DuplicateGroup {
  @ApiProperty()
  key: string;

  @ApiProperty({ type: [DuplicateTransactionItem] })
  transactions: DuplicateTransactionItem[];

  @ApiProperty()
  reason: string;

  @ApiProperty({ enum: DUPLICATE_REASON_CODES })
  reasonCode: DuplicateReasonCode;

  @ApiProperty({
    description: "Largest date difference the sensitivity allowed, in days",
  })
  windowDays: number;

  @ApiProperty({ enum: DUPLICATE_CONFIDENCE_LEVELS })
  confidence: DuplicateConfidence;
}

export class DuplicateTransactionsSummary {
  @ApiProperty()
  totalGroups: number;

  @ApiProperty()
  veryHighCount: number;

  @ApiProperty()
  highCount: number;

  @ApiProperty()
  mediumCount: number;

  @ApiProperty()
  lowCount: number;

  @ApiProperty()
  potentialSavings: number;
}

export class DuplicateTransactionsResponse {
  @ApiProperty({ type: [DuplicateGroup] })
  groups: DuplicateGroup[];

  @ApiProperty({ type: DuplicateTransactionsSummary })
  summary: DuplicateTransactionsSummary;
}
