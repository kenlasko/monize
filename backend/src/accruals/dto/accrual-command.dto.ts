import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Min,
  Max,
  ValidateIf,
  IsDefined,
} from "class-validator";
import type { AccrualDateRule } from "../accrual-allocation";

export class AccrualPreviewDto {
  @IsUUID() sourceTransactionId: string;
  @IsOptional() @IsUUID() sourceSplitId?: string | null;
  @IsIn(["LTM", "NTM", "CUSTOM"]) preset: "LTM" | "NTM" | "CUSTOM";
  @ValidateIf((o) => o.preset === "CUSTOM")
  @Matches(/^\d{4}-\d{2}$/)
  startMonth?: string;
  @ValidateIf((o) => o.preset === "CUSTOM")
  @IsInt()
  @Min(1)
  @Max(600)
  monthCount?: number;
  @IsOptional() @IsIn(["expense", "income"]) family?: "expense" | "income";
  @IsOptional()
  @IsIn(["MONTH_END", "FIRST_BUSINESS_DAY"])
  dateRule?: AccrualDateRule;
}
export class AccrualCommitDto extends AccrualPreviewDto {
  @Matches(/^[a-f0-9]{64}$/) fingerprint: string;
  @ValidateIf((_o, value) => value !== null)
  @IsDefined()
  @IsUUID()
  expectedScheduleId: string | null;
  @ValidateIf((_o, value) => value !== null)
  @IsDefined()
  @IsInt()
  @Min(1)
  @Max(2147483647)
  expectedRevision: number | null;
}
export class AccrualRemoveDto {
  @Matches(/^[a-f0-9]{64}$/) fingerprint: string;
  @IsInt() @Min(1) @Max(2147483647) expectedRevision: number;
}
