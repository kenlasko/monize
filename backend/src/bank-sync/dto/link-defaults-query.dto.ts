import { ApiProperty } from "@nestjs/swagger";
import { IsUUID } from "class-validator";

/**
 * `GET /bank-sync/accounts/:id/link-defaults?accountId=<uuid>`. A DTO rather
 * than a `@Query()` string: a repeated key arrives as an array, which
 * `@IsUUID` refuses instead of letting a regular expression coerce it.
 */
export class LinkDefaultsQueryDto {
  @ApiProperty({
    format: "uuid",
    description: "The Monize account the bank account would be linked to.",
  })
  @IsUUID()
  accountId: string;
}
