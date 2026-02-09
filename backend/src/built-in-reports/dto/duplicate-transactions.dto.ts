import { ApiProperty } from "@nestjs/swagger";

export class DuplicateTransactionItem {
  @ApiProperty()
  id: string;

  @ApiProperty()
  transactionDate: string;

  @ApiProperty()
  amount: number;

  @ApiProperty({ nullable: true })
  payeeName: string | null;

  @ApiProperty({ nullable: true })
  description: string | null;

  @ApiProperty({ nullable: true })
  accountName: string | null;
}

export class DuplicateGroup {
  @ApiProperty()
  key: string;

  @ApiProperty({ type: [DuplicateTransactionItem] })
  transactions: DuplicateTransactionItem[];

  @ApiProperty()
  reason: string;

  @ApiProperty({ enum: ["high", "medium", "low"] })
  confidence: "high" | "medium" | "low";
}

export class DuplicateTransactionsSummary {
  @ApiProperty()
  totalGroups: number;

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
