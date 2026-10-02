import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsIn, ValidateIf } from "class-validator";
import { BANK_SYNC_NOTIFY_SUCCESS_MODES } from "../bank-sync.constants";
import type { BankSyncNotifySuccessMode } from "../bank-sync.constants";

/**
 * `PATCH /bank-sync/connections/:id`. Every field is optional and only the
 * fields present are written; a body with none is refused by the service, so a
 * request that changes nothing is not answered as a success. An explicit `null`
 * is not "absent": it is validated, and refused, rather than skipped.
 */
export class UpdateBankSyncConnectionDto {
  @ApiPropertyOptional({
    description: "Whether the daily sync reads this connection.",
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  autoSync?: boolean;

  @ApiPropertyOptional({
    description:
      "When the daily sync of this connection reports a successful run.",
    enum: BANK_SYNC_NOTIFY_SUCCESS_MODES,
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsIn([...BANK_SYNC_NOTIFY_SUCCESS_MODES])
  notifySuccess?: BankSyncNotifySuccessMode;

  @ApiPropertyOptional({
    description:
      "Whether a synced transaction is tagged with the bank's operation type (card payment, transfer, ...).",
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsBoolean()
  tagOperationType?: boolean;
}
