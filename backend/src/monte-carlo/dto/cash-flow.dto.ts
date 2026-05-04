import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export enum CashFlowTypeDto {
  ONE_TIME = "ONE_TIME",
  RECURRING = "RECURRING",
}

export class CashFlowDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  @SanitizeHtml()
  name: string;

  /** Signed: positive = income, negative = expense. */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-999999999999)
  @Max(999999999999)
  amount: number;

  @IsEnum(CashFlowTypeDto)
  flowType: CashFlowTypeDto;

  /** Year offset from today; 1 = first simulated year. */
  @IsInt()
  @Min(1)
  @Max(100)
  startYear: number;

  /** Inclusive end year for RECURRING; null/omitted = until horizon ends. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  endYear?: number;

  @IsBoolean()
  inflationAdjust: boolean;
}
