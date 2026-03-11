import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsOptional, MaxLength, IsUUID, ValidateIf } from "class-validator";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class CreatePayeeDto {
  @ApiProperty({ example: "Starbucks", description: "Name of the payee" })
  @IsString()
  @MaxLength(100)
  @SanitizeHtml()
  name: string;

  @ApiProperty({
    example: "category-uuid",
    required: false,
    description: "Default category ID for transactions with this payee",
  })
  @IsOptional()
  @ValidateIf((o) => o.defaultCategoryId !== null)
  @IsUUID()
  defaultCategoryId?: string | null;

  @ApiProperty({
    example: "Local coffee shop on Main Street",
    required: false,
    description: "Notes about the payee",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @SanitizeHtml()
  notes?: string;
}
