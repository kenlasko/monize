import { IsInt, IsOptional, Min, Max } from "class-validator";
import { Type } from "class-transformer";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
export class AccrualSystemMovementsQueryDto {
  @IsCalendarDate() startDate: string;
  @IsCalendarDate() endDate: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000) limit?: number;
}
