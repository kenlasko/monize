import {
  IsArray,
  IsNumber,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";

export class BulkCategoryAmountDto {
  @ApiProperty({ description: "Budget category ID" })
  @IsUUID()
  id: string;

  @ApiProperty({ description: "New amount" })
  @IsNumber()
  @Min(0)
  amount: number;
}

export class BulkUpdateBudgetCategoriesDto {
  @ApiProperty({
    description: "Array of category amounts to update",
    type: [BulkCategoryAmountDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkCategoryAmountDto)
  categories: BulkCategoryAmountDto[];
}
