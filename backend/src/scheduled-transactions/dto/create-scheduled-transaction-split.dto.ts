import {
  IsNumber,
  IsUUID,
  IsOptional,
  IsString,
  ValidateIf,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class CreateScheduledTransactionSplitDto {
  @ApiPropertyOptional({
    description:
      "Category ID for expense/income splits (mutually exclusive with transferAccountId)",
  })
  @IsOptional()
  @IsUUID()
  @ValidateIf((o) => !o.transferAccountId)
  categoryId?: string;

  @ApiPropertyOptional({
    description:
      "Target account ID for transfer splits (mutually exclusive with categoryId)",
  })
  @IsOptional()
  @IsUUID()
  @ValidateIf((o) => !o.categoryId)
  transferAccountId?: string;

  @IsNumber()
  amount: number;

  @IsOptional()
  @IsString()
  memo?: string;
}
