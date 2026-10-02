import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsString, Matches } from "class-validator";

/** ISO 3166-1 alpha-2, upper case: the provider's `country` parameter. */
export const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

/**
 * `GET /bank-sync/institutions?country=PL`. A DTO rather than a `@Query()
 * string`: a repeated key arrives as an array, which `@IsString` refuses
 * instead of letting a regular expression coerce it (backend/CLAUDE.md).
 */
export class ListInstitutionsQueryDto {
  @ApiProperty({
    example: "PL",
    description: "ISO 3166-1 alpha-2 country code.",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(COUNTRY_CODE_PATTERN, {
    message: "country must be an ISO 3166-1 alpha-2 code such as PL",
  })
  country: string;
}
