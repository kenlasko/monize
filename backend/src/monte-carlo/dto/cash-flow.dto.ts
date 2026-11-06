import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";
import { IsMoneyAmount } from "../../common/validators/is-money-amount.validator";

/**
 * Most cash flows one scenario may carry. The simulation is synchronous and
 * does work proportional to simulations x years x cash flows, so the list is
 * bounded on every path that stores or runs one: the DTO (`@ArrayMaxSize`),
 * the service (saved scenarios, including rows restored from a backup), and
 * the client's "add cash flow" control (`MAX_CASH_FLOWS` in
 * frontend/src/lib/monte-carlo.ts), which must stay equal to this.
 */
export const MAX_SCENARIO_CASH_FLOWS = 100;

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
  @IsMoneyAmount(4)
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
