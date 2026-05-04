import { PartialType } from "@nestjs/mapped-types";
import { IsBoolean, IsOptional } from "class-validator";
import { CreateScenarioDto } from "./create-scenario.dto";

export class UpdateScenarioDto extends PartialType(CreateScenarioDto) {
  @IsOptional()
  @IsBoolean()
  isFavourite?: boolean;
}
