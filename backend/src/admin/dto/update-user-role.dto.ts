import { IsString, IsIn } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class UpdateUserRoleDto {
  @ApiProperty({ enum: ["admin", "user"], description: "User role" })
  @IsString()
  @IsIn(["admin", "user"])
  role: string;
}
