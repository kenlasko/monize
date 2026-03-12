import { IsDateString, IsNumber, IsOptional, Max, Min } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CreateSecurityPriceDto {
  @ApiProperty({ description: "Price date in ISO format" })
  @IsDateString()
  priceDate: string;

  @ApiProperty({ description: "Closing price" })
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(999999999999)
  closePrice: number;

  @ApiProperty({ description: "Opening price", required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(999999999999)
  openPrice?: number;

  @ApiProperty({ description: "High price", required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(999999999999)
  highPrice?: number;

  @ApiProperty({ description: "Low price", required: false })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(999999999999)
  lowPrice?: number;

  @ApiProperty({ description: "Trading volume", required: false })
  @IsOptional()
  @IsNumber()
  @Min(0)
  volume?: number;
}
