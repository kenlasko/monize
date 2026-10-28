import { Type } from "class-transformer";
import { IsUUID, ValidateNested, IsDefined } from "class-validator";
import { UpdateTransactionDto } from "../../transactions/dto/update-transaction.dto";
export class AccrualSourceEditDto {
  @IsUUID() sourceTransactionId: string;
  @IsDefined()
  @ValidateNested()
  @Type(() => UpdateTransactionDto)
  patch: UpdateTransactionDto;
}
