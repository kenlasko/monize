import { IsDateString, IsNumber, IsOptional, Max, Min } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

export class CreateSecurityPriceDto {
  @ApiProperty({ description: "Price date in ISO format" })
  @IsDateString()
  priceDate: string;

  @ApiProperty({ description: "Closing price" })
  @IsMoneyAmount(10)
  @Min(0)
  @Max(999999999999)
  closePrice: number;

  @ApiProperty({ description: "Opening price", required: false })
  @IsOptional()
  @IsMoneyAmount(10)
  @Min(0)
  @Max(999999999999)
  openPrice?: number;

  @ApiProperty({ description: "High price", required: false })
  @IsOptional()
  @IsMoneyAmount(10)
  @Min(0)
  @Max(999999999999)
  highPrice?: number;

  @ApiProperty({ description: "Low price", required: false })
  @IsOptional()
  @IsMoneyAmount(10)
  @Min(0)
  @Max(999999999999)
  lowPrice?: number;

  @ApiProperty({ description: "Trading volume", required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;
}
