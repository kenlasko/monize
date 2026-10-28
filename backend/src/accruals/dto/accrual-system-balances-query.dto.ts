import { ArrayMaxSize, IsArray, IsOptional, IsUUID } from "class-validator";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";

export class AccrualSystemBalancesQueryDto {
  @IsCalendarDate()
  asOf: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID("all", { each: true })
  accountIds?: string[];
}
