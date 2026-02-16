import {
  IsString,
  IsNumber,
  IsOptional,
  IsUUID,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class CreateTransactionSplitDto {
  @ApiPropertyOptional({
    description:
      "Category ID for this split (mutually exclusive with transferAccountId)",
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    description:
      "Target account ID for transfer split (mutually exclusive with categoryId)",
  })
  @IsOptional()
  @IsUUID()
  transferAccountId?: string;

  @ApiProperty({
    description:
      "Amount for this split (must be same sign as parent transaction)",
  })
  @IsNumber({ maxDecimalPlaces: 4 })
  amount: number;

  @ApiPropertyOptional({ description: "Memo/note for this split" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  memo?: string;
}
