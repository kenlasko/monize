import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsOptional, MaxLength, IsUUID } from "class-validator";

export class CreatePayeeDto {
  @ApiProperty({ example: "Starbucks", description: "Name of the payee" })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({
    example: "category-uuid",
    required: false,
    description: "Default category ID for transactions with this payee",
  })
  @IsOptional()
  @IsUUID()
  defaultCategoryId?: string;

  @ApiProperty({
    example: "Local coffee shop on Main Street",
    required: false,
    description: "Notes about the payee",
  })
  @IsOptional()
  @IsString()
  notes?: string;
}
