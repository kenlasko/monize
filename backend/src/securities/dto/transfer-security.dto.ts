import { ApiProperty } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsNumber,
  IsUUID,
  IsDateString,
  Min,
  MaxLength,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class TransferSecurityDto {
  @ApiProperty({
    description: "Investment account the shares are moving out of",
  })
  @IsUUID()
  fromAccountId: string;

  @ApiProperty({ description: "Investment account the shares are moving into" })
  @IsUUID()
  toAccountId: string;

  @ApiProperty({ description: "Security being transferred" })
  @IsUUID()
  securityId: string;

  @ApiProperty({ description: "Transfer date (YYYY-MM-DD)" })
  @IsDateString()
  transactionDate: string;

  @ApiProperty({ description: "Number of shares to transfer" })
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0.00000001)
  quantity: number;

  @ApiProperty({
    description:
      "Per-share cost basis carried to the destination account. Defaults (client-side) to the source holding's average cost so gain/profit reporting is preserved.",
  })
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  costPerShare: number;

  @ApiProperty({ required: false, description: "Description of the transfer" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  description?: string;
}
