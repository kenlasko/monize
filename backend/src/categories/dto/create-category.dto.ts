import {
  IsString,
  IsOptional,
  IsBoolean,
  IsUUID,
  MaxLength,
  Matches,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateCategoryDto {
  @ApiProperty({ description: "Category name" })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({ description: "Category description" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: "Icon name or emoji" })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @ApiPropertyOptional({ description: "Color in hex format (e.g., #FF5733)" })
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9A-Fa-f]{6}$/, {
    message: "Color must be in hex format (e.g., #FF5733)",
  })
  color?: string;

  @ApiPropertyOptional({
    description: "Whether this is an income category (false for expense)",
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isIncome?: boolean;

  @ApiPropertyOptional({
    description: "Parent category ID for creating subcategories",
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;
}
