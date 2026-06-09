import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  MaxLength,
  IsUrl,
  Matches,
} from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class CreateInstitutionDto {
  @ApiProperty({
    example: "TD Canada Trust",
    description: "Name of the financial institution",
  })
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  name: string;

  @ApiProperty({
    example: "https://www.td.com",
    description:
      "Institution website. Used to resolve the brand favicon. The protocol is optional (https is assumed).",
  })
  @IsString()
  @MaxLength(2048)
  @IsUrl({ require_protocol: false, require_tld: true })
  website: string;

  @ApiPropertyOptional({
    example: "CA",
    description: "Optional ISO 3166-1 alpha-2 country code",
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2}$/, {
    message: "country must be a 2-letter ISO country code",
  })
  country?: string;
}
