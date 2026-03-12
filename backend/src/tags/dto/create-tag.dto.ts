import { IsString, IsOptional, MaxLength, Matches } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class CreateTagDto {
  @ApiProperty({ description: "Tag name" })
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiPropertyOptional({ description: "Hex color (e.g. #FF5733)" })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: "color must be a valid hex color (e.g. #FF5733)",
  })
  color?: string;

  @ApiPropertyOptional({ description: "Icon name" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;
}
