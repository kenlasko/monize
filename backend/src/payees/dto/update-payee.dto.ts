import { PartialType } from "@nestjs/swagger";
import { IsBoolean, IsIn, IsOptional } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { CreatePayeeDto } from "./create-payee.dto";

export type ApplyCategoryToTransactions = "none" | "uncategorized" | "all";

export class UpdatePayeeDto extends PartialType(CreatePayeeDto) {
  @ApiProperty({
    example: true,
    required: false,
    description: "Whether the payee is active",
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({
    example: "uncategorized",
    required: false,
    enum: ["none", "uncategorized", "all"],
    description:
      "When a default category is set, optionally apply it to the payee's existing transactions: 'uncategorized' only fills transactions with no category, 'all' overwrites every transaction (transfers and split parents are never touched). Defaults to 'none'.",
  })
  @IsOptional()
  @IsIn(["none", "uncategorized", "all"])
  applyCategoryToTransactions?: ApplyCategoryToTransactions;
}
