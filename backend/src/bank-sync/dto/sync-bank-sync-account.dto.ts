import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from "class-validator";

/** A SHA-256 hex digest: what `planFingerprint` returns. */
export const PLAN_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** The most keys one request names: a bank's whole window, with room to spare. */
export const MAX_SYNC_KEYS = 5000;

/** The width of `bank_sync_imported_transactions.external_key`. */
export const MAX_SYNC_KEY_LENGTH = 255;

/**
 * `POST /bank-sync/accounts/:id/sync`. The body is optional. `planFingerprint`
 * is the one a preview returned: with it the write refuses (409), before it
 * writes anything, when the plan it is about to write is not the one shown
 * (spec section 7a).
 *
 * `importKeys` and `excludeKeys` are the person's selection from the preview
 * (spec section 7b). Either one given means "only these": the keys in
 * `importKeys` are imported, those in `excludeKeys` are added to the exceptions,
 * and the two must not share a key. A key that is not a new row of the plan the
 * write makes is refused (400). With neither, every new row is imported. An
 * explicit `null` is not "absent": it is refused rather than read as "import
 * everything".
 */
export class SyncBankSyncAccountDto {
  @ApiPropertyOptional({
    description: "The planFingerprint of the preview the user confirmed.",
    example: "0f".repeat(32),
    nullable: true,
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null && value !== "")
  @IsString()
  @Matches(PLAN_FINGERPRINT_PATTERN, {
    message: "planFingerprint must be a lowercase SHA-256 hex digest",
  })
  planFingerprint?: string | null;

  @ApiPropertyOptional({
    description:
      "The external keys of the new rows to import. With it (or excludeKeys) only these rows are imported.",
    type: [String],
    maxItems: MAX_SYNC_KEYS,
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(MAX_SYNC_KEYS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(MAX_SYNC_KEY_LENGTH, { each: true })
  importKeys?: string[];

  @ApiPropertyOptional({
    description:
      "The external keys of the new rows to add to the exceptions: no later sync imports them until they are removed from the exceptions.",
    type: [String],
    maxItems: MAX_SYNC_KEYS,
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(MAX_SYNC_KEYS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(MAX_SYNC_KEY_LENGTH, { each: true })
  excludeKeys?: string[];
}
