import { IsArray, ArrayMaxSize, IsDateString, IsUUID } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class BulkReconcileDto {
  @ApiProperty({
    description: "Array of transaction IDs to reconcile",
    type: [String],
  })
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID("4", { each: true })
  transactionIds: string[];

  @ApiProperty({
    description: "Reconciliation date (YYYY-MM-DD format)",
  })
  @IsDateString()
  reconciledDate: string;
}
