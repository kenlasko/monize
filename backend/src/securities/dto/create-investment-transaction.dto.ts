import { ApiProperty } from "@nestjs/swagger";
import {
  IsString,
  IsEnum,
  IsOptional,
  IsNumber,
  IsUUID,
  IsDateString,
  Min,
} from "class-validator";
import { InvestmentAction } from "../entities/investment-transaction.entity";

export class CreateInvestmentTransactionDto {
  @ApiProperty()
  @IsUUID()
  accountId: string;

  @ApiProperty({ enum: InvestmentAction })
  @IsEnum(InvestmentAction)
  action: InvestmentAction;

  @ApiProperty()
  @IsDateString()
  transactionDate: string;

  @ApiProperty({
    required: false,
    description: "Security ID for buy/sell transactions",
  })
  @IsOptional()
  @IsUUID()
  securityId?: string;

  @ApiProperty({
    required: false,
    description: "Account where funds come from (BUY) or go to (SELL)",
  })
  @IsOptional()
  @IsUUID()
  fundingAccountId?: string;

  @ApiProperty({ required: false, description: "Number of shares" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  quantity?: number;

  @ApiProperty({ required: false, description: "Price per share" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  price?: number;

  @ApiProperty({
    required: false,
    description: "Commission or fee",
    default: 0,
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  commission?: number;

  @ApiProperty({
    required: false,
    description: "Description of the transaction",
  })
  @IsOptional()
  @IsString()
  description?: string;
}
