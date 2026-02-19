import { IsEnum, IsIn, IsOptional } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { BudgetStrategy } from "../entities/budget.entity";

export enum BudgetProfile {
  COMFORTABLE = "COMFORTABLE",
  ON_TRACK = "ON_TRACK",
  AGGRESSIVE = "AGGRESSIVE",
}

export class GenerateBudgetDto {
  @ApiProperty({
    description: "Number of months to analyze",
    enum: [3, 6, 12],
  })
  @IsIn([3, 6, 12])
  analysisMonths: number;

  @ApiPropertyOptional({
    description: "Budget strategy to apply",
    enum: BudgetStrategy,
    default: BudgetStrategy.FIXED,
  })
  @IsOptional()
  @IsEnum(BudgetStrategy)
  strategy?: BudgetStrategy;

  @ApiPropertyOptional({
    description: "Budget profile for suggestion amounts",
    enum: BudgetProfile,
    default: BudgetProfile.ON_TRACK,
  })
  @IsOptional()
  @IsEnum(BudgetProfile)
  profile?: BudgetProfile;
}
