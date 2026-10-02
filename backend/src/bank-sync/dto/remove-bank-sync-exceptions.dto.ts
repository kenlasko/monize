import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import {
  MAX_SYNC_KEYS,
  MAX_SYNC_KEY_LENGTH,
} from "./sync-bank-sync-account.dto";

/**
 * `POST /bank-sync/accounts/:id/exceptions/remove` (spec section 7b): the keys of
 * the exceptions to take back, so the next sync shows those bank transactions as
 * new again. Only a ledger row that is an exception (`excluded_at` set, no
 * transaction) can be removed; any other key is ignored.
 */
export class RemoveBankSyncExceptionsDto {
  @ApiProperty({
    description: "The external keys of the exceptions to remove.",
    type: [String],
    minItems: 1,
    maxItems: MAX_SYNC_KEYS,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SYNC_KEYS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(MAX_SYNC_KEY_LENGTH, { each: true })
  keys: string[];
}
