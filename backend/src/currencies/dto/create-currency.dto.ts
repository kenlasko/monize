import { ApiProperty } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  MaxLength,
  IsBoolean,
  IsInt,
  Min,
  Max,
  Length,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class CreateCurrencyDto {
  @ApiProperty({ example: "CAD", description: "ISO 4217 currency code" })
  @IsString()
  @Length(3, 3, { message: "Currency code must be exactly 3 characters" })
  code: string;

  @ApiProperty({ example: "Canadian Dollar" })
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiProperty({ example: "$" })
  @IsString()
  @MaxLength(10)
  @SanitizeHtml()
  symbol: string;

  @ApiProperty({ example: 2, required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4)
  decimalPlaces?: number;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
