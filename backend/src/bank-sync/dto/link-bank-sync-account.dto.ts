import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsUUID, ValidateIf } from "class-validator";
import { IsCalendarDate } from "../../common/validators/is-calendar-date.validator";

/**
 * `PATCH /bank-sync/accounts/:id`. `accountId` is required and nullable: a UUID
 * links, `null` unlinks, and an absent key is refused rather than read as
 * either. `syncFromDate` is optional; the server defaults it (spec section 7).
 */
export class LinkBankSyncAccountDto {
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  @ValidateIf((_o, value) => value !== null)
  @IsUUID()
  accountId: string | null;

  @ApiPropertyOptional({ example: "2026-01-01", nullable: true })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsCalendarDate()
  syncFromDate?: string | null;
}
