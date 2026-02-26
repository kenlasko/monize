import { IsArray, ArrayMaxSize, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";
import { CreateTransactionSplitDto } from "./create-transaction-split.dto";

export class UpdateSplitsDto {
  @ApiProperty({
    description: "Replacement splits for the transaction",
    type: [CreateTransactionSplitDto],
  })
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateTransactionSplitDto)
  splits: CreateTransactionSplitDto[];
}
