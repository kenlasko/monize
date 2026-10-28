import { IsEnum, IsOptional, Matches } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { TransactionStatus } from "../entities/transaction.entity";

export class UpdateTransactionStatusDto {
  @ApiProperty({
    description: "New transaction status",
    enum: TransactionStatus,
  })
  @IsEnum(TransactionStatus)
  status: TransactionStatus;

  @ApiPropertyOptional({
    description: "Fingerprint from the accrual source-edit preview",
  })
  @IsOptional()
  @Matches(/^[a-f0-9]{64}$/)
  accrualImpactFingerprint?: string;
}
