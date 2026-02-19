import { IsArray, IsUUID, ArrayMaxSize, ArrayMinSize } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CategoryBudgetStatusDto {
  @ApiProperty({
    description: "Category IDs to check budget status for",
    type: [String],
  })
  @IsArray()
  @IsUUID("4", { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  categoryIds: string[];
}
