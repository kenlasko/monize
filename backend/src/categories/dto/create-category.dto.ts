import {
  IsString,
  IsOptional,
  IsBoolean,
  IsIn,
  IsUUID,
  MaxLength,
  Matches,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { CATEGORY_TYPES, CategoryType } from "../category-type.util";
import { SanitizeHtml } from "../../common/decorators/sanitize-html.decorator";

export class CreateCategoryDto {
  @ApiProperty({ description: "Category name" })
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  name: string;

  @ApiPropertyOptional({ description: "Category description" })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  @SanitizeHtml()
  description?: string;

  @ApiPropertyOptional({ description: "Icon name or emoji" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @SanitizeHtml()
  icon?: string;

  @ApiPropertyOptional({ description: "Color in hex format (e.g., #FF5733)" })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: "Color must be in hex format (e.g., #FF5733)",
  })
  color?: string;

  @ApiPropertyOptional({
    description:
      "The category type. A subcategory has its parent's type, so a request naming another type for one is refused. A Transfer category goes only on a transfer.",
    enum: CATEGORY_TYPES,
    default: "expense",
  })
  @IsOptional()
  @IsIn(CATEGORY_TYPES)
  type?: CategoryType;

  @ApiPropertyOptional({
    description:
      "Automatic amount sign for this category: true/false is an explicit choice, omitted or null inherits from the nearest ancestor that has one (a root with no value behaves as on)",
    nullable: true,
  })
  @IsOptional()
  @IsBoolean()
  autoSign?: boolean | null;

  @ApiPropertyOptional({
    description: "Parent category ID for creating subcategories",
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
