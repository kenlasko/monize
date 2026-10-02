import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsIn,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
} from "class-validator";
import { BANK_SYNC_PSU_TYPES } from "../bank-sync.constants";
import type { BankSyncPsuType } from "../bank-sync.constants";
import { COUNTRY_CODE_PATTERN } from "./list-institutions-query.dto";

/** The width of `bank_sync_connections.institution_name`. */
export const INSTITUTION_NAME_MAX_LENGTH = 255;

/**
 * `POST /bank-sync/connections`. The client never supplies a consent validity:
 * the server asks the provider for the institution's maximum (spec section 5).
 */
export class CreateBankSyncConnectionDto {
  @ApiProperty({
    description: "The bank's name exactly as the institution list gave it.",
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(INSTITUTION_NAME_MAX_LENGTH)
  institutionName: string;

  @ApiProperty({ example: "PL" })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(COUNTRY_CODE_PATTERN, {
    message: "country must be an ISO 3166-1 alpha-2 code such as PL",
  })
  country: string;

  @ApiProperty({ enum: BANK_SYNC_PSU_TYPES })
  @IsIn(BANK_SYNC_PSU_TYPES)
  psuType: BankSyncPsuType;
}
