import { PartialType, OmitType } from "@nestjs/swagger";
import { CreateCurrencyDto } from "./create-currency.dto";

export class UpdateCurrencyDto extends PartialType(
  OmitType(CreateCurrencyDto, ["code"] as const),
) {}
