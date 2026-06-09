import { PartialType } from "@nestjs/swagger";
import { CreateInstitutionDto } from "./create-institution.dto";

export class UpdateInstitutionDto extends PartialType(CreateInstitutionDto) {}
