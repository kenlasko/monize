import {
  IsOptional,
  IsBoolean,
  IsIn,
  IsArray,
  ArrayMaxSize,
  IsUUID,
  IsInt,
  Min,
  Max,
} from "class-validator";
import { Type, Transform } from "class-transformer";
import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";
import type { ReportingBasis } from "../reporting-basis";
export class ReportingDetailsQueryDto {
  @ApiProperty() @IsCalendarDate() startDate: string;
  @ApiProperty() @IsCalendarDate() endDate: string;
  @ApiPropertyOptional({ enum: ["cash", "accrual"] })
  @IsOptional()
  @IsIn(["cash", "accrual"])
  basis?: ReportingBasis;
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? [value] : value))
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID("all", { each: true })
  sourceTransactionIds?: string[];
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? [value] : value))
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID("all", { each: true })
  accountIds?: string[];
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? [value] : value))
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID("all", { each: true })
  categoryIds?: string[];
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? [value] : value))
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID("all", { each: true })
  payeeIds?: string[];
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? [value] : value))
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID("all", { each: true })
  tagIds?: string[];
  @IsOptional() @IsIn(["income", "expense"]) categoryType?:
    "income" | "expense";
  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  uncategorized?: boolean;
  @IsOptional() @IsIn(["ordinary", "transfer", "investment", "all"]) kind?:
    "ordinary" | "transfer" | "investment" | "all";
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000) limit?: number;
}
