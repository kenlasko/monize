import { IsEnum } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { TransactionStatus } from "../entities/transaction.entity";

export class UpdateTransactionStatusDto {
  @ApiProperty({
    description: "New transaction status",
    enum: TransactionStatus,
  })
  @IsEnum(TransactionStatus)
  status: TransactionStatus;
}
