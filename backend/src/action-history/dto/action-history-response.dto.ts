import { IsOptional, IsInt, Min, Max } from "class-validator";
import { Type } from "class-transformer";

export class ActionHistoryQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
