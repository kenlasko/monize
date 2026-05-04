import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { CashFlowDto } from "./cash-flow.dto";

/**
 * Shared input fields used by both `CreateScenarioDto` and the ad-hoc
 * `RunScenarioDto`. Kept as a base class so validation rules stay in sync.
 */
export class ScenarioInputs {
  @IsArray()
  @IsUUID("4", { each: true })
  accountIds: string[];

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999999999)
  startingValue: number;

  @IsBoolean()
  useCurrentBalance: boolean;

  @IsInt()
  @Min(0)
  @Max(100)
  yearsToRetirement: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-999999999)
  @Max(999999999)
  annualContribution: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-1)
  @Max(1)
  contributionGrowthRate: number;

  @IsInt()
  @Min(0)
  @Max(100)
  yearsInRetirement: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999999)
  annualWithdrawal: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-1)
  @Max(1)
  expectedReturn: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(1)
  volatility: number;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(-1)
  @Max(1)
  inflationRate: number;

  @IsBoolean()
  showRealValues: boolean;

  /**
   * When true, the backend recomputes mean return and volatility from the
   * selected accounts' transaction history at run time and ignores
   * `expectedReturn` / `volatility` in the request.
   */
  @IsBoolean()
  useHistoricalReturns: boolean;

  @IsInt()
  @Min(100)
  @Max(50000)
  simulationCount: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(999999999999)
  targetValue?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  randomSeed?: string | null;

  /** Optional one-time or recurring cash-flow events layered on top of the
   * base contribution/withdrawal phases. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CashFlowDto)
  cashFlows?: CashFlowDto[];
}
