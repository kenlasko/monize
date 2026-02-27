import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MaxLength,
  Matches,
  IsDateString,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsFutureDate } from "../../common/validators/is-future-date.validator";

export class CreatePatDto {
  @ApiProperty({ description: "User-assigned label for the token" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    description: "Comma-separated scopes: read, write, reports",
    default: "read",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^(read|write|reports)(,(read|write|reports))*$/, {
    message: "Scopes must be comma-separated values of: read, write, reports",
  })
  scopes?: string;

  @ApiPropertyOptional({ description: "Token expiration date (ISO 8601)" })
  @IsOptional()
  @IsDateString()
  @IsFutureDate({ message: "Expiration date must be in the future" })
  expiresAt?: string;
}
