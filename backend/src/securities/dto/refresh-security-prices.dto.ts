import { IsArray, IsUUID, ArrayMaxSize } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class RefreshSecurityPricesDto {
  @ApiProperty({
    description: "Array of security UUIDs to refresh prices for",
    type: [String],
  })
  @IsArray()
  @IsUUID("4", { each: true })
  @ArrayMaxSize(100)
  securityIds: string[];
}
