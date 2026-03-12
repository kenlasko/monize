import { PartialType } from "@nestjs/swagger";
import { CreateSecurityPriceDto } from "./create-security-price.dto";

export class UpdateSecurityPriceDto extends PartialType(
  CreateSecurityPriceDto,
) {}
